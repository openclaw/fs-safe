//! Advisory transport only. No backend pathname is an authority for JS metadata.
use crate::{NativeResult, native_error};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU32, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
#[cfg(target_os = "linux")]
#[path = "watch_linux.rs"]
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
}
#[path = "watch_callback.rs"]
mod callback;
use callback::Callback;
#[derive(Default)]
pub(super) struct Pending {
    paths: BTreeMap<(String, String), bool>,
    overflow: bool,
    limit: usize,
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
        if self.paths.is_empty() && !self.overflow {
            return None;
        }
        Some(WatchBatch {
            overflow: std::mem::take(&mut self.overflow),
            hints: std::mem::take(&mut self.paths)
                .into_iter()
                .map(|((directory, name), structural)| WatchHint {
                    directory,
                    name,
                    structural,
                })
                .collect(),
        })
    }
}
pub(super) type SharedPending = Arc<Mutex<Pending>>;
pub(super) struct Registration {
    pending: SharedPending,
    callback: Callback,
}
type Reply = mpsc::SyncSender<NativeResult<()>>;
enum Command {
    Register(u32, String, Registration, Reply),
    Add(
        u32,
        String,
        String,
        crate::ExactFileIdentity,
        crate::ExactFileIdentity,
        Reply,
    ),
    Remove(u32, Reply),
}
struct Hub {
    sender: mpsc::Sender<Command>,
    thread: JoinHandle<()>,
    registrations: usize,
}
static HUB: Mutex<Option<Hub>> = Mutex::new(None);
static NEXT: AtomicU32 = AtomicU32::new(1);
static THREADS: AtomicU32 = AtomicU32::new(0);
thread_local! {
    static CLEANUPS: std::cell::RefCell<HashMap<u32, napi::CleanupEnvHook<u32>>> = std::cell::RefCell::new(HashMap::new());
}
fn unavailable() -> napi::Error<String> {
    native_error("ENOTSUP", "native watch hub is unavailable")
}
fn run(receiver: mpsc::Receiver<Command>, started: Reply) {
    let mut backend = match platform::Backend::new() {
        Ok(backend) => backend,
        Err(error) => {
            let _ = started.send(Err(error));
            return;
        }
    };
    THREADS.fetch_add(1, Ordering::SeqCst);
    let mut registrations: HashMap<u32, Registration> = HashMap::new();
    let _ = started.send(Ok(()));
    loop {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(Command::Register(id, root, registration, reply)) => {
                let result = backend.register(id, &root, registration.pending.clone());
                if result.is_ok() {
                    registrations.insert(id, registration);
                }
                let _ = reply.send(result);
            }
            Ok(Command::Add(id, root, relative, root_identity, identity, reply)) => {
                let _ = reply.send(backend.add(id, &root, &relative, root_identity, identity));
            }
            Ok(Command::Remove(id, reply)) => {
                let result = backend.remove(id);
                registrations.remove(&id);
                let _ = reply.send(result);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        backend.poll();
        for registration in registrations.values_mut() {
            let mut pending = registration.pending.lock().unwrap();
            if let Some(batch) = pending.take() {
                // There is at most one queued batch per registration. A blocked JS
                // loop cannot block the hub or grow native pending memory unboundedly.
                if !registration.callback.send(batch) {
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
        Ok(()) => Ok(Hub {
            sender,
            thread,
            registrations: 0,
        }),
        Err(error) => {
            let _ = thread.join();
            Err(error)
        }
    }
}
fn stop_if_empty(slot: &mut Option<Hub>) -> NativeResult<()> {
    if slot.as_ref().is_some_and(|hub| hub.registrations == 0) {
        let hub = slot.take().unwrap();
        drop(hub.sender);
        hub.thread
            .join()
            .map_err(|_| native_error("EIO", "watch hub failed while joining"))?;
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
    let mut slot = HUB.lock().unwrap();
    if slot.is_none() {
        *slot = Some(start()?);
    }
    let hub = slot.as_mut().unwrap();
    let (reply, result) = mpsc::sync_channel(1);
    hub.sender
        .send(Command::Register(
            id,
            root,
            Registration {
                callback,
                pending: Arc::new(Mutex::new(Pending {
                    limit: limit as usize,
                    ..Pending::default()
                })),
            },
            reply,
        ))
        .map_err(|_| unavailable())?;
    if let Err(error) = result.recv().unwrap_or_else(|_| Err(unavailable())) {
        stop_if_empty(&mut slot)?;
        return Err(error);
    }
    hub.registrations += 1;
    drop(slot);
    match env.add_env_cleanup_hook(id, |id| {
        CLEANUPS.with(|hooks| {
            hooks.borrow_mut().remove(&id);
        });
        let _ = unregister(id);
    }) {
        Ok(hook) => {
            CLEANUPS.with(|hooks| {
                hooks.borrow_mut().insert(id, hook);
            });
        }
        Err(error) => {
            unregister(id)?;
            return Err(native_error("EIO", error));
        }
    }
    Ok(id)
}
fn add_impl(
    id: u32,
    root: String,
    relative: String,
    root_dev: BigInt,
    root_ino: BigInt,
    dev: BigInt,
    ino: BigInt,
) -> NativeResult<()> {
    crate::validate_relative_path(&relative, true)?;
    let root_identity = crate::exact_file_identity(&root_dev, &root_ino)?;
    let identity = crate::exact_file_identity(&dev, &ino)?;
    let slot = HUB.lock().unwrap();
    let hub = slot.as_ref().ok_or_else(unavailable)?;
    let (reply, result) = mpsc::sync_channel(1);
    hub.sender
        .send(Command::Add(
            id,
            root,
            relative,
            root_identity,
            identity,
            reply,
        ))
        .map_err(|_| unavailable())?;
    result.recv().unwrap_or_else(|_| Err(unavailable()))
}
fn unregister(id: u32) -> NativeResult<()> {
    let mut slot = HUB.lock().unwrap();
    let Some(hub) = slot.as_mut() else {
        return Ok(());
    };
    let (reply, result) = mpsc::sync_channel(1);
    hub.sender
        .send(Command::Remove(id, reply))
        .map_err(|_| unavailable())?;
    let removed = result.recv().unwrap_or_else(|_| Err(unavailable()));
    hub.registrations -= 1;
    let joined = stop_if_empty(&mut slot);
    removed.and(joined)
}
fn unregister_impl(env: Env, id: u32) -> NativeResult<()> {
    let hook = CLEANUPS.with(|hooks| hooks.borrow_mut().remove(&id));
    if let Some(hook) = hook {
        let removed = unregister(id);
        env.remove_env_cleanup_hook(hook)
            .map_err(|error| native_error("EIO", error))?;
        removed?;
    }
    Ok(())
}
#[napi]
pub fn watch_register(
    env: Env,
    root: String,
    limit: u32,
    callback: Function<WatchBatch, ()>,
) -> Result<u32> {
    crate::into_napi(env, register_impl(env, root, limit, callback))
}
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn watch_add(
    env: Env,
    id: u32,
    root: String,
    relative: String,
    root_dev: BigInt,
    root_ino: BigInt,
    dev: BigInt,
    ino: BigInt,
) -> Result<()> {
    crate::into_napi(
        env,
        add_impl(id, root, relative, root_dev, root_ino, dev, ino),
    )
}
#[napi]
pub fn watch_unregister(env: Env, id: u32) -> Result<()> {
    crate::into_napi(env, unregister_impl(env, id))
}
#[napi]
pub fn watch_thread_count() -> u32 {
    THREADS.load(Ordering::SeqCst)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_is_bounded_and_overflow_erases_names() {
        let mut pending = Pending {
            limit: 1,
            ..Pending::default()
        };
        pending.push("".into(), "a".into(), false);
        pending.push("".into(), "a".into(), true);
        assert_eq!(pending.paths.len(), 1);
        pending.push("".into(), "b".into(), false);
        let batch = pending.take().unwrap();
        assert!(batch.overflow && batch.hints.is_empty());
        assert!(pending.take().is_none());
    }
    #[test]
    fn idle_hub_is_joined() {
        let hub = start().unwrap();
        assert_eq!(watch_thread_count(), 1);
        let mut slot = Some(hub);
        stop_if_empty(&mut slot).unwrap();
        assert_eq!(watch_thread_count(), 0);
    }
}
