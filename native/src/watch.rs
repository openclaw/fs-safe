//! Advisory transport only. No backend pathname is an authority for JS metadata.
use crate::{NativeResult, native_error};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::c_void;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
#[cfg(target_os = "linux")]
#[path = "watch_linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "watch_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "watch_windows.rs"]
mod platform;

#[napi(object)]
pub struct WatchHint {
    pub directory: String,
    pub name: String,
    pub structural: bool,
}
#[napi(object)]
pub struct WatchBatch {
    pub hints: Vec<WatchHint>,
    pub overflow: bool,
    pub error: Option<String>,
}
#[path = "watch_callback.rs"]
mod callback;
use callback::Callback;
#[derive(Default)]
pub(super) struct Pending {
    paths: BTreeMap<(String, String), bool>,
    overflow: bool,
    limit: usize,
    error: Option<String>,
}
impl Pending {
    pub(super) fn overflow(&mut self) {
        self.paths.clear();
        self.overflow = true;
    }
    pub(super) fn push(&mut self, directory: String, name: String, structural: bool) {
        if self.overflow {
            return;
        }
        let key = (directory, name);
        if !self.paths.contains_key(&key) && self.paths.len() >= self.limit {
            self.overflow();
            return;
        }
        *self.paths.entry(key).or_default() |= structural;
    }
    fn take(&mut self) -> Option<WatchBatch> {
        if self.paths.is_empty() && !self.overflow && self.error.is_none() {
            return None;
        }
        Some(WatchBatch {
            error: self.error.clone(),
            overflow: std::mem::take(&mut self.overflow),
            hints: std::mem::take(&mut self.paths)
                .into_iter()
                .map(|((directory, name), structural)| WatchHint { directory, name, structural })
                .collect(),
        })
    }
}
pub(super) type SharedPending = Arc<Mutex<Pending>>;
pub(super) struct Registration {
    pending: SharedPending,
    callback: Callback,
    notify: Notify,
}
#[napi(object)]
pub struct WatchDirectory {
    pub root: String,
    pub relative: String,
    pub root_dev: BigInt,
    pub root_ino: BigInt,
    pub dev: BigInt,
    pub ino: BigInt,
}
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // macOS and Windows observe the entire Root.
pub(super) struct Directory {
    root: String,
    relative: String,
    root_identity: crate::ExactFileIdentity,
    identity: crate::ExactFileIdentity,
}
type Reply = mpsc::SyncSender<NativeResult<()>>;
enum Command {
    Register(u32, String, Registration, Reply),
    Add(u32, Directory, Reply),
    Remove(u32, Reply),
    Drain(u32),
    Stop,
    #[cfg(target_os = "macos")]
    TestEvent(u32, String, u32, Reply),
}
#[derive(Clone)]
struct Commands {
    sender: mpsc::Sender<Command>,
    waker: platform::Waker,
}
impl Commands {
    fn send(&self, command: Command) -> NativeResult<()> {
        self.sender.send(command).map_err(|_| unavailable())?;
        self.waker.wake();
        Ok(())
    }
}
#[derive(Clone)]
pub(super) struct Notify {
    id: u32,
    commands: Commands,
    queued: Arc<AtomicBool>,
}
impl Notify {
    fn wake(&self) {
        // Coalesce dispatch callbacks and JS acknowledgements to one queued drain per owner.
        if !self.queued.swap(true, Ordering::AcqRel) {
            let _ = self.commands.send(Command::Drain(self.id));
        }
    }
}
struct Hub {
    commands: Commands,
    thread: JoinHandle<()>,
    registrations: usize,
}
static HUB: Mutex<Option<Hub>> = Mutex::new(None);
static NEXT: AtomicU32 = AtomicU32::new(1);
static THREADS: AtomicU32 = AtomicU32::new(0);
thread_local! {
    static CLEANUPS: std::cell::RefCell<HashSet<u32>> = std::cell::RefCell::new(HashSet::new());
}
// napi-rs 3.12's removal API leaves its boxed cleanup context allocated. Node
// treats this data as opaque: the never-reused id needs no heap allocation.
fn cleanup_data(id: u32) -> *mut c_void {
    std::ptr::without_provenance_mut(id as usize)
}
unsafe extern "C" fn cleanup_env(data: *mut c_void) {
    let id = data.addr() as u32;
    if CLEANUPS.with(|hooks| hooks.borrow_mut().remove(&id)) {
        let _ = unregister(id);
    }
}
fn unavailable() -> napi::Error<String> {
    native_error("ENOTSUP", "native watch hub is unavailable")
}
fn run(receiver: mpsc::Receiver<Command>, started: mpsc::SyncSender<NativeResult<platform::Waker>>) {
    let mut backend = match platform::Backend::new() {
        Ok(backend) => backend,
        Err(error) => {
            let _ = started.send(Err(error));
            return;
        }
    };
    THREADS.fetch_add(1, Ordering::SeqCst);
    let mut registrations: HashMap<u32, Registration> = HashMap::new();
    let _ = started.send(Ok(backend.waker()));
    'running: loop {
        // Darwin receives dispatch callbacks as commands. The other backends block
        // on their kernel event source plus a command waker, without periodic ticks.
        #[cfg(target_os = "macos")]
        let first = match receiver.recv() {
            Ok(command) => Some(command),
            Err(_) => break,
        };
        #[cfg(not(target_os = "macos"))]
        let first = {
            backend.wait();
            None
        };
        for command in first.into_iter().chain(receiver.try_iter()) {
            match command {
                Command::Register(id, root, registration, reply) => {
                    let result = backend.register(
                        id,
                        &root,
                        registration.pending.clone(),
                        registration.notify.clone(),
                    );
                    if result.is_ok() {
                        registrations.insert(id, registration);
                    }
                    let _ = reply.send(result);
                }
                Command::Add(id, directory, reply) => {
                    let _ = reply.send(backend.add(id, &directory));
                }
                Command::Remove(id, reply) => {
                    let result = backend.remove(id);
                    registrations.remove(&id);
                    let _ = reply.send(result);
                }
                Command::Drain(id) => {
                    if let Some(registration) = registrations.get(&id) {
                        registration.notify.queued.store(false, Ordering::Release);
                    }
                }
                Command::Stop => break 'running,
                #[cfg(target_os = "macos")]
                Command::TestEvent(id, path, flags, reply) => {
                    let _ = reply.send(backend.test_event(id, &path, flags));
                }
            }
        }
        for registration in registrations.values_mut() {
            let mut pending = registration.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(batch) = pending.take() {
                // A full queue retries only when JS consumes the queued batch.
                if !registration.callback.send(batch, registration.notify.clone()) {
                    pending.overflow();
                }
            }
        }
    }
    drop(backend);
    THREADS.fetch_sub(1, Ordering::SeqCst);
}
fn start() -> NativeResult<Hub> {
    let (sender, receiver) = mpsc::channel();
    let (reply, result) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("fs-safe-watch".into())
        .spawn(move || run(receiver, reply))
        .map_err(|error| native_error("EIO", error))?;
    match result.recv().unwrap_or_else(|_| Err(unavailable())) {
        Ok(waker) => Ok(Hub { commands: Commands { sender, waker }, thread, registrations: 0 }),
        Err(error) => {
            let _ = thread.join();
            Err(error)
        }
    }
}
fn stop_if_empty(slot: &mut Option<Hub>) -> NativeResult<()> {
    if slot.as_ref().is_some_and(|hub| hub.registrations == 0) {
        let hub = slot.take().unwrap();
        let _ = hub.commands.send(Command::Stop);
        hub.thread.join().map_err(|_| native_error("EIO", "watch hub failed while joining"))?;
    }
    Ok(())
}
fn register_impl(
    env: Env,
    root: String,
    limit: u32,
    callback: Function<WatchBatch, ()>,
) -> NativeResult<u32> {
    if !(1..=4096).contains(&limit) {
        return Err(native_error("EINVAL", "invalid watch pending limit"));
    }
    let id = NEXT
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |id| id.checked_add(1))
        .map_err(|_| unavailable())?;
    let callback = Callback::new(env, callback)?;
    let mut slot = HUB.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        *slot = Some(start()?);
    }
    let hub = slot.as_mut().unwrap();
    let registration = Registration {
        callback,
        notify: Notify { id, commands: hub.commands.clone(), queued: Arc::new(AtomicBool::new(false)) },
        pending: Arc::new(Mutex::new(Pending { limit: limit as usize, ..Pending::default() })),
    };
    if let Err(error) = request(hub, |reply| Command::Register(id, root, registration, reply)) {
        stop_if_empty(&mut slot)?;
        return Err(error);
    }
    hub.registrations += 1;
    drop(slot);
    let status = unsafe { napi::sys::napi_add_env_cleanup_hook(env.raw(), Some(cleanup_env), cleanup_data(id)) };
    if status != napi::sys::Status::napi_ok {
        unregister(id)?;
        return Err(native_error("EIO", "install watch environment cleanup"));
    }
    CLEANUPS.with(|hooks| hooks.borrow_mut().insert(id));
    Ok(id)
}
fn add_impl(id: u32, value: WatchDirectory) -> NativeResult<()> {
    crate::validate_relative_path(&value.relative, true)?;
    let directory = Directory {
        root_identity: crate::exact_file_identity(&value.root_dev, &value.root_ino)?,
        identity: crate::exact_file_identity(&value.dev, &value.ino)?,
        root: value.root,
        relative: value.relative,
    };
    let slot = HUB.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let hub = slot.as_ref().ok_or_else(unavailable)?;
    request(hub, |reply| Command::Add(id, directory, reply))
}
fn request(hub: &Hub, command: impl FnOnce(Reply) -> Command) -> NativeResult<()> {
    let (reply, result) = mpsc::sync_channel(1);
    hub.commands.send(command(reply))?;
    result.recv().unwrap_or_else(|_| Err(unavailable()))
}
fn unregister(id: u32) -> NativeResult<()> {
    let mut slot = HUB.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(hub) = slot.as_mut() else {
        return Ok(());
    };
    let removed = request(hub, |reply| Command::Remove(id, reply));
    hub.registrations -= 1;
    let joined = stop_if_empty(&mut slot);
    removed.and(joined)
}
fn unregister_impl(env: Env, id: u32) -> NativeResult<()> {
    if CLEANUPS.with(|hooks| hooks.borrow().contains(&id)) {
        let status = unsafe { napi::sys::napi_remove_env_cleanup_hook(env.raw(), Some(cleanup_env), cleanup_data(id)) };
        if status != napi::sys::Status::napi_ok {
            return Err(native_error("EIO", "remove watch environment cleanup"));
        }
        CLEANUPS.with(|hooks| hooks.borrow_mut().remove(&id));
        unregister(id)?;
    }
    Ok(())
}
#[napi]
pub fn watch_register(env: Env, root: String, limit: u32, callback: Function<WatchBatch, ()>) -> Result<u32> {
    crate::into_napi(env, register_impl(env, root, limit, callback))
}
#[napi]
pub fn watch_add(env: Env, id: u32, directory: WatchDirectory) -> Result<()> {
    crate::into_napi(env, add_impl(id, directory))
}
#[napi]
pub fn watch_unregister(env: Env, id: u32) -> Result<()> {
    crate::into_napi(env, unregister_impl(env, id))
}
#[napi]
pub fn watch_thread_count() -> u32 {
    THREADS.load(Ordering::SeqCst)
}
#[cfg(target_os = "macos")]
#[napi]
pub fn watch_test_event(env: Env, id: u32, path: String, flags: u32) -> Result<()> {
    let result = (|| {
        let slot = HUB.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let hub = slot.as_ref().ok_or_else(unavailable)?;
        request(hub, |reply| Command::TestEvent(id, path, flags, reply))
    })();
    crate::into_napi(env, result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_is_bounded_and_overflow_erases_names() {
        let mut pending = Pending { limit: 1, ..Pending::default() };
        pending.push("".into(), "a".into(), false);
        pending.push("".into(), "a".into(), true);
        assert_eq!(pending.paths.len(), 1);
        pending.push("".into(), "b".into(), false);
        let batch = pending.take().unwrap();
        assert!(batch.overflow && batch.hints.is_empty());
        assert!(pending.take().is_none());
    }
    #[test]
    fn drains_are_coalesced_and_poisoned_pending_is_recovered() {
        let backend = platform::Backend::new().unwrap();
        let (sender, receiver) = mpsc::channel();
        let notify = Notify {
            id: 7,
            commands: Commands { sender, waker: backend.waker() },
            queued: Arc::new(AtomicBool::new(false)),
        };
        for _ in 0..100 {
            notify.wake();
        }
        assert!(matches!(receiver.try_recv(), Ok(Command::Drain(7))));
        assert!(receiver.try_recv().is_err());
        notify.queued.store(false, Ordering::Release);
        notify.wake();
        assert!(matches!(receiver.try_recv(), Ok(Command::Drain(7))));
        let pending = Arc::new(Mutex::new(Pending::default()));
        let other = pending.clone();
        let _ = thread::spawn(move || {
            let _guard = other.lock().unwrap();
            panic!("test poison");
        })
        .join();
        let mut pending = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.overflow();
        assert!(pending.take().unwrap().overflow);
    }
    #[test]
    fn idle_hub_is_joined() {
        let hub = start().unwrap();
        assert_eq!(watch_thread_count(), 1);
        for id in 0..100 {
            request(&hub, |reply| Command::Remove(id, reply)).unwrap();
        }
        let mut slot = Some(hub);
        stop_if_empty(&mut slot).unwrap();
        assert_eq!(watch_thread_count(), 0);
    }
}
