use super::{Directory, Notify, SharedPending};
use crate::{NativeResult, native_error};
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::ptr::null_mut;
type Ref = *mut c_void;
#[repr(C)]
struct Context {
    version: isize,
    info: Ref,
    retain: Ref,
    release: Ref,
    description: Ref,
}
type EventCallback = unsafe extern "C" fn(Ref, Ref, usize, Ref, *const u32, *const u64);
#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn FSEventStreamCreate(
        allocator: Ref,
        callback: EventCallback,
        context: *mut Context,
        paths: Ref,
        since: u64,
        latency: f64,
        flags: u32,
    ) -> Ref;
    fn FSEventStreamSetDispatchQueue(stream: Ref, queue: Ref);
    fn FSEventStreamSetExclusionPaths(stream: Ref, paths: Ref) -> u8;
    fn FSEventStreamStart(stream: Ref) -> u8;
    fn FSEventStreamStop(stream: Ref);
    fn FSEventStreamInvalidate(stream: Ref);
    fn FSEventStreamRelease(stream: Ref);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeArrayCallBacks: [usize; 5];
    fn CFStringCreateWithCString(allocator: Ref, string: *const c_char, encoding: u32) -> Ref;
    fn CFArrayCreate(allocator: Ref, values: *const Ref, count: isize, callbacks: Ref) -> Ref;
    fn CFRelease(value: Ref);
}
unsafe extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: Ref) -> Ref;
    fn dispatch_sync_f(queue: Ref, context: Ref, work: unsafe extern "C" fn(Ref));
    fn dispatch_release(queue: Ref);
}
#[derive(Clone)]
pub(super) struct Waker;
impl Waker {
    pub fn wake(&self) {} // The channel send itself wakes recv() on Darwin.
}
struct Events {
    prefix: String,
    pending: SharedPending,
    notify: Option<Notify>,
}
struct Stream {
    root: String,
    _paths: CfValue,
    _exclusions: CfValue,
    stream: Ref,
    events: Box<Events>,
}
struct CfValue(Ref);
impl Drop for CfValue {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}
fn paths_array(paths: &[String]) -> NativeResult<CfValue> {
    let mut strings = Vec::new();
    for path in paths {
        let path = CString::new(path.as_str()).map_err(|_| native_error("EINVAL", "invalid watch path"))?;
        let string = unsafe { CFStringCreateWithCString(null_mut(), path.as_ptr(), 0x08000100) };
        if string.is_null() {
            return Err(native_error("ENOMEM", "create FSEvents path string"));
        }
        strings.push(CfValue(string));
    }
    let values: Vec<_> = strings.iter().map(|value| value.0).collect();
    let array = unsafe {
        CFArrayCreate(
            null_mut(),
            values.as_ptr(),
            values.len() as isize,
            (&raw const kCFTypeArrayCallBacks).cast_mut().cast(),
        )
    };
    if array.is_null() {
        return Err(native_error("ENOMEM", "create FSEvents paths"));
    }
    Ok(CfValue(array))
}
fn validate_paths(root: &str, anchors: &[String], exclusions: &[String]) -> NativeResult<()> {
    if anchors.is_empty() || anchors.len() > 128 || exclusions.len() > 8 {
        return Err(native_error("EINVAL", "invalid FSEvents path count"));
    }
    let prefix = format!("{}/", root.trim_end_matches('/'));
    for path in anchors.iter().chain(exclusions) {
        if path == root {
            continue;
        }
        let relative =
            path.strip_prefix(&prefix).ok_or_else(|| native_error("EINVAL", "watch path outside Root"))?;
        crate::validate_relative_path(relative, false)?;
    }
    Ok(())
}
pub(super) struct Backend {
    queue: Ref,
    streams: HashMap<u32, Stream>,
}
unsafe extern "C" fn callback(_: Ref, info: Ref, count: usize, paths: Ref, flags: *const u32, _: *const u64) {
    // SAFETY: the boxed context survives until stop/invalidate plus queue barrier.
    let events = unsafe { &*(info.cast::<Events>()) };
    for index in 0..count {
        let flag = unsafe { *flags.add(index) };
        let path = unsafe { CStr::from_ptr(*(paths.cast::<*const c_char>()).add(index)) }.to_str();
        events.record(path.ok(), flag);
    }
    if let Some(notify) = &events.notify {
        notify.wake();
    }
}
impl Events {
    fn record(&self, path: Option<&str>, flags: u32) {
        let mut pending = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Dropped/wrapped streams, RootChanged and Unmount require guarded reconciliation.
        if flags & (1 | 2 | 4 | 8 | 32 | 128) != 0 {
            pending.overflow();
            return;
        }
        if flags & 16 != 0 {
            return;
        } // HistoryDone carries no filesystem change.
        if flags & 0xff00 == 0 {
            pending.overflow();
            return;
        }
        let Some(relative) = path.and_then(|p| p.strip_prefix(&self.prefix)).filter(|p| !p.is_empty()) else {
            return; // Activity only: never retain an outside pathname.
        };
        if relative.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
            return;
        }
        let (directory, name) = relative.rsplit_once('/').unwrap_or(("", relative));
        pending.push_with_flags(
            directory.into(),
            name.into(),
            flags & (0x100 | 0x200 | 0x800) != 0,
            Some(flags),
        );
    }
}

unsafe extern "C" fn retire(stream: Ref) {
    unsafe {
        FSEventStreamStop(stream);
        FSEventStreamInvalidate(stream);
        FSEventStreamRelease(stream);
    }
}
unsafe extern "C" fn barrier(_: Ref) {}
impl Backend {
    pub fn new() -> NativeResult<Self> {
        let queue = unsafe { dispatch_queue_create(c"fs-safe-watch".as_ptr(), null_mut()) };
        if queue.is_null() {
            return Err(native_error("ENOMEM", "create watch dispatch queue"));
        }
        Ok(Self { queue, streams: HashMap::new() })
    }
    pub fn register(
        &mut self,
        id: u32,
        root: &str,
        pending: SharedPending,
        notify: Notify,
    ) -> NativeResult<()> {
        self.register_paths(id, root, pending, notify, &[root.to_owned()], &[])
    }
    fn register_paths(
        &mut self,
        id: u32,
        root: &str,
        pending: SharedPending,
        notify: Notify,
        anchors: &[String],
        exclusions: &[String],
    ) -> NativeResult<()> {
        validate_paths(root, anchors, exclusions)?;
        let array = paths_array(anchors)?;
        let excluded = paths_array(exclusions)?;
        let mut events = Box::new(Events {
            prefix: format!("{}/", root.trim_end_matches('/')),
            pending,
            notify: Some(notify),
        });
        let mut context = Context {
            version: 0,
            info: (&mut *events as *mut Events).cast(),
            retain: null_mut(),
            release: null_mut(),
            description: null_mut(),
        };
        let stream = unsafe {
            FSEventStreamCreate(null_mut(), callback, &mut context, array.0, u64::MAX, 0.03, 0x10 | 0x2 | 0x4)
        };
        if stream.is_null() {
            return Err(native_error("EIO", "create FSEvents stream"));
        }
        unsafe {
            FSEventStreamSetDispatchQueue(stream, self.queue);
        }
        if (!exclusions.is_empty() && unsafe { FSEventStreamSetExclusionPaths(stream, excluded.0) } == 0)
            || unsafe { FSEventStreamStart(stream) } == 0
        {
            unsafe {
                dispatch_sync_f(self.queue, stream, retire);
                dispatch_sync_f(self.queue, null_mut(), barrier);
            }
            return Err(native_error("EIO", "configure/start FSEvents stream"));
        }
        self.streams
            .insert(id, Stream { root: root.into(), _paths: array, _exclusions: excluded, stream, events });
        Ok(())
    }
    pub fn configure(&mut self, id: u32, anchors: &[String], exclusions: &[String]) -> NativeResult<()> {
        let old =
            self.streams.get(&id).ok_or_else(|| native_error("EINVAL", "unknown watch registration"))?;
        validate_paths(&old.root, anchors, exclusions)?;
        let root = old.root.clone();
        let pending = old.events.pending.clone();
        let notify = old.events.notify.clone().unwrap();
        self.remove(id)?;
        self.register_paths(id, &root, pending, notify, anchors, exclusions)
    }
    pub fn add(&mut self, _: u32, _: &Directory) -> NativeResult<()> {
        Ok(())
    }
    pub fn remove(&mut self, id: u32) -> NativeResult<()> {
        if let Some(stream) = self.streams.remove(&id) {
            unsafe {
                dispatch_sync_f(self.queue, stream.stream, retire);
                dispatch_sync_f(self.queue, null_mut(), barrier);
            }
            drop(stream.events);
        }
        Ok(())
    }
    pub fn test_event(&self, id: u32, path: &str, flags: u32) -> NativeResult<()> {
        let stream =
            self.streams.get(&id).ok_or_else(|| native_error("EINVAL", "unknown watch registration"))?;
        stream.events.record(Some(path), flags);
        Ok(())
    }
    pub fn waker(&self) -> Waker {
        Waker
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        for id in self.streams.keys().copied().collect::<Vec<_>>() {
            let _ = self.remove(id);
        }
        unsafe {
            dispatch_release(self.queue);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::Pending;
    use std::sync::{Arc, Mutex};
    #[test]
    fn decoder_preserves_inside_names_and_discards_outside_paths() {
        let pending = Arc::new(Mutex::new(Pending { limit: 2, ..Pending::default() }));
        let events = Events { prefix: "/admitted/".into(), pending: pending.clone(), notify: None };
        events.record(Some("/admitted/kept"), 0x1000);
        let batch = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().unwrap();
        assert!(!batch.overflow);
        assert_eq!(batch.hints.len(), 1);
        assert_eq!(batch.hints[0].name, "kept");
        for path in ["/admitted-other/private", "/admitted/../private", "/outside/private"] {
            events.record(Some(path), 0x1000);
            assert!(pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().is_none());
        }
    }
}
