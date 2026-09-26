//! Explicit payload ownership: napi-rs 3.12's TSFN call leaks rejected payloads.
use super::WatchBatch;
use crate::{NativeResult, native_error};
use napi::{Env, JsValue, bindgen_prelude::*, sys};
use std::ffi::c_void;
use std::ptr::null_mut;

pub(super) struct Callback(sys::napi_threadsafe_function);
// Node-API explicitly permits transferring a TSFN's thread permit to the hub.
unsafe impl Send for Callback {}

fn enqueue<T>(value: T, call: impl FnOnce(*mut c_void) -> sys::napi_status) -> sys::napi_status {
    let payload = Box::into_raw(Box::new(value));
    let status = call(payload.cast());
    if status != sys::Status::napi_ok {
        // Node-API takes ownership only on success, including during env teardown.
        unsafe {
            drop(Box::from_raw(payload));
        }
    }
    status
}
unsafe extern "C" fn deliver(
    env: sys::napi_env,
    function: sys::napi_value,
    _: *mut c_void,
    data: *mut c_void,
) {
    // A queued batch must be freed even when Node is draining a closing environment.
    let batch = unsafe { Box::from_raw(data.cast::<WatchBatch>()) };
    if env.is_null() || function.is_null() {
        return;
    }
    let result = unsafe { Function::<WatchBatch, ()>::from_napi_value(env, function) }
        .and_then(|callback| callback.call(*batch));
    if let Err(error) = result {
        // Internal JS delivery normally cannot throw; preserve Node's async exception semantics.
        let value = unsafe { napi::JsError::from(error).into_value(env) };
        unsafe {
            sys::napi_fatal_exception(env, value);
        }
    }
}
impl Callback {
    pub fn new(env: Env, callback: Function<WatchBatch, ()>) -> NativeResult<Self> {
        let mut name = null_mut();
        let label = b"fs-safe-watch";
        let status = unsafe {
            sys::napi_create_string_utf8(
                env.raw(),
                label.as_ptr().cast(),
                label.len() as isize,
                &mut name,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(native_error("EIO", "create watch callback name"));
        }
        let mut raw = null_mut();
        // One thread permit, a one-batch queue, and the default referenced event-loop lifetime.
        let status = unsafe {
            sys::napi_create_threadsafe_function(
                env.raw(),
                callback.value().value,
                null_mut(),
                name,
                1,
                1,
                null_mut(),
                None,
                null_mut(),
                Some(deliver),
                &mut raw,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(native_error("EIO", "create watch callback"));
        }
        Ok(Self(raw))
    }
    pub fn send(&mut self, batch: WatchBatch) -> bool {
        if self.0.is_null() {
            return false;
        }
        let status = enqueue(batch, |payload| unsafe {
            sys::napi_call_threadsafe_function(
                self.0,
                payload,
                sys::ThreadsafeFunctionCallMode::nonblocking,
            )
        });
        // napi_closing revokes this thread's permit. Never touch that TSFN again.
        if status == sys::Status::napi_closing {
            self.0 = null_mut();
        }
        status == sys::Status::napi_ok
    }
}
impl Drop for Callback {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                sys::napi_release_threadsafe_function(
                    self.0,
                    sys::ThreadsafeFunctionReleaseMode::release,
                );
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
            enqueue(Payload(&dropped), |_| sys::Status::napi_queue_full);
            enqueue(Payload(&dropped), |_| sys::Status::napi_closing);
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 2000);
    }
}
