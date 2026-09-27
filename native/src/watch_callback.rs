//! Explicit payload ownership: napi-rs 3.12's TSFN call leaks rejected payloads.
use super::{Notify, WatchBatch};
use crate::{NativeResult, native_error};
use napi::{Env, JsValue, bindgen_prelude::*, sys};
use std::ffi::c_void;
use std::ptr::null_mut;

struct Payload {
    batch: WatchBatch,
    notify: Notify,
    _lifetime: super::memory::PayloadLifetime,
}

unsafe extern "C" fn finalized(_: sys::napi_env, _: *mut c_void, _: *mut c_void) {
    super::memory::tsfn_destroyed();
}

pub(super) struct Callback(sys::napi_threadsafe_function);
// Node-API explicitly permits transferring a TSFN's thread permit to the hub.
unsafe impl Send for Callback {}

fn enqueue<T>(
    value: T,
    call: impl FnOnce(*mut c_void) -> sys::napi_status,
) -> std::result::Result<(), (sys::napi_status, T)> {
    let payload = Box::into_raw(Box::new(value));
    let status = call(payload.cast());
    if status != sys::Status::napi_ok {
        // Node-API takes ownership only on success, including during env teardown.
        return Err((status, unsafe { *Box::from_raw(payload) }));
    }
    Ok(())
}
unsafe extern "C" fn deliver(
    env: sys::napi_env,
    function: sys::napi_value,
    _: *mut c_void,
    data: *mut c_void,
) {
    // A queued batch must be freed even when Node is draining a closing environment.
    let payload = unsafe { Box::from_raw(data.cast::<Payload>()) };
    payload.notify.wake();
    if env.is_null() || function.is_null() {
        return;
    }
    let result = unsafe { Function::<WatchBatch, ()>::from_napi_value(env, function) }
        .and_then(|callback| callback.call(payload.batch));
    if let Err(error) = result {
        // Internal JS delivery normally cannot throw; preserve Node's async exception semantics.
        let value = unsafe { napi::JsError::from(error).into_value(env) };
        unsafe {
            sys::napi_fatal_exception(env, value);
        }
    }
}
impl Callback {
    pub fn new(env: Env, callback: Function<WatchBatch, ()>, persistent: bool) -> NativeResult<Self> {
        let mut name = null_mut();
        let label = b"fs-safe-watch";
        let status = unsafe {
            sys::napi_create_string_utf8(env.raw(), label.as_ptr().cast(), label.len() as isize, &mut name)
        };
        if status != sys::Status::napi_ok {
            return Err(native_error("EIO", "create watch callback name"));
        }
        let mut raw = null_mut();
        // One thread permit and one queued batch per registration.
        let status = unsafe {
            sys::napi_create_threadsafe_function(
                env.raw(),
                callback.value().value,
                null_mut(),
                name,
                1,
                1,
                null_mut(),
                Some(finalized),
                null_mut(),
                Some(deliver),
                &mut raw,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(native_error("EIO", "create watch callback"));
        }
        super::memory::tsfn_created();
        let callback = Self(raw);
        if !persistent {
            // This registration's libuv handle is unref'd on the JS thread before
            // the hub can enqueue delivery. The native hub owns no Node handles.
            let status = unsafe { sys::napi_unref_threadsafe_function(env.raw(), raw) };
            if status != sys::Status::napi_ok {
                return Err(native_error("EIO", "unref watch callback"));
            }
        }
        Ok(callback)
    }
    pub fn send(&mut self, batch: WatchBatch, notify: Notify) -> std::result::Result<(), WatchBatch> {
        if self.0.is_null() {
            return Err(batch);
        }
        let result = enqueue(Payload { batch, notify, _lifetime: Default::default() }, |payload| unsafe {
            sys::napi_call_threadsafe_function(self.0, payload, sys::ThreadsafeFunctionCallMode::nonblocking)
        });
        // napi_closing revokes this thread's permit. Never touch that TSFN again.
        result.map_err(|(status, payload)| {
            if status == sys::Status::napi_closing {
                self.0 = null_mut();
            }
            payload.batch
        })
    }
}
impl Drop for Callback {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                sys::napi_release_threadsafe_function(self.0, sys::ThreadsafeFunctionReleaseMode::release);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn diagnostics_survive_hint_coalescing_and_callback_retry() {
        let mut pending = super::super::Pending { limit: 1, ..Default::default() };
        pending.push_with_flags("".into(), "config.json".into(), true, Some(0x100));
        pending.push_with_flags("".into(), "config.json".into(), false, Some(0x1000));
        let batch = pending.take().unwrap();
        pending.restore(batch);
        let batch = pending.take().unwrap();
        assert!(batch.hints[0].structural);
        assert_eq!(batch.hints[0].flags, Some(0x1100));
    }
    #[test]
    fn rejected_payloads_are_reclaimed_on_full_queue_and_shutdown() {
        struct Payload<'a>(&'a AtomicUsize);
        impl Drop for Payload<'_> {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = AtomicUsize::new(0);
        for _ in 0..1000 {
            drop(enqueue(Payload(&dropped), |_| sys::Status::napi_queue_full));
            drop(enqueue(Payload(&dropped), |_| sys::Status::napi_closing));
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 2000);
    }
    #[test]
    fn full_queue_returns_the_undelivered_value() {
        let result = enqueue(String::from("retained detail"), |_| sys::Status::napi_queue_full);
        assert_eq!(result, Err((sys::Status::napi_queue_full, String::from("retained detail"))));
    }
}
