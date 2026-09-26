use super::{Directory, SharedPending};
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
struct Events {
    prefix: String,
    pending: SharedPending,
}
struct Stream {
    paths: Ref,
    stream: Ref,
    events: Box<Events>,
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
}
impl Events {
    fn record(&self, path: Option<&str>, flags: u32) {
        let mut pending = self.pending.lock().unwrap();
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
            pending.overflow();
            return; // Activity only: never retain an outside pathname.
        };
        if relative.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
            pending.overflow();
            return;
        }
        let (directory, name) = relative.rsplit_once('/').unwrap_or(("", relative));
        pending.push(directory.into(), name.into(), flags & (0x100 | 0x200 | 0x800) != 0);
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
    pub fn register(&mut self, id: u32, root: &str, pending: SharedPending) -> NativeResult<()> {
        let path = CString::new(root).map_err(|_| native_error("EINVAL", "invalid watch root"))?;
        let mut events = Box::new(Events { prefix: format!("{}/", root.trim_end_matches('/')), pending });
        let mut context = Context {
            version: 0,
            info: (&mut *events as *mut Events).cast(),
            retain: null_mut(),
            release: null_mut(),
            description: null_mut(),
        };
        // The array borrows the CFString until stream creation has retained its paths.
        let string = unsafe { CFStringCreateWithCString(null_mut(), path.as_ptr(), 0x08000100) };
        if string.is_null() {
            return Err(native_error("ENOMEM", "create FSEvents root string"));
        }
        let array =
            unsafe { CFArrayCreate(null_mut(), &string, 1, (&raw const kCFTypeArrayCallBacks).cast_mut().cast()) };
        if array.is_null() {
            unsafe { CFRelease(string) };
            return Err(native_error("ENOMEM", "create FSEvents paths"));
        }
        let stream =
            unsafe { FSEventStreamCreate(null_mut(), callback, &mut context, array, u64::MAX, 0.03, 0x10 | 0x2 | 0x4) };
        unsafe {
            CFRelease(string);
        }
        if stream.is_null() {
            unsafe { CFRelease(array); }
            return Err(native_error("EIO", "create FSEvents stream"));
        }
        unsafe {
            FSEventStreamSetDispatchQueue(stream, self.queue);
        }
        if unsafe { FSEventStreamStart(stream) } == 0 {
            unsafe {
                dispatch_sync_f(self.queue, stream, retire);
                dispatch_sync_f(self.queue, null_mut(), barrier);
            }
            unsafe { CFRelease(array); }
            return Err(native_error("EIO", "start FSEvents stream"));
        }
        self.streams.insert(id, Stream { paths: array, stream, events });
        Ok(())
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
            unsafe { CFRelease(stream.paths); }
            drop(stream.events);
        }
        Ok(())
    }
    pub fn test_event(&self, id: u32, path: &str, flags: u32) -> NativeResult<()> {
        let stream = self.streams.get(&id).ok_or_else(|| native_error("EINVAL", "unknown watch registration"))?;
        stream.events.record(Some(path), flags);
        Ok(())
    }
    pub fn poll(&mut self) {}
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
