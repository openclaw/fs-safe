use super::{Directory, Notify, SharedPending};
use crate::{ExactFileIdentity, NativeResult, native_error};
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct Waker(Arc<OwnedFd>);
impl Waker {
    pub fn wake(&self) {
        let value = 1u64;
        loop {
            let written = unsafe { libc::write(self.0.as_raw_fd(), (&raw const value).cast(), 8) };
            if written >= 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                // EAGAIN means an existing wake already fills the counter.
                break;
            }
        }
    }
}
pub(super) struct Backend {
    fd: OwnedFd,
    waker: Waker,
    pending: HashMap<u32, SharedPending>,
    watches: HashMap<i32, HashMap<u32, HashSet<String>>>,
}
fn error(operation: &str) -> napi::Error<String> {
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOSPC) {
        native_error("watch-limit", "inotify watch limit exhausted")
    } else {
        crate::unix::os_error(
            rustix::io::Errno::from_raw_os_error(error.raw_os_error().unwrap_or(libc::EIO)),
            operation,
        )
    }
}
impl Backend {
    pub fn new() -> NativeResult<Self> {
        // SAFETY: no pointer arguments; returned descriptor is uniquely owned.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(error("initialize inotify"));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let wake_fd = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
        if wake_fd < 0 {
            return Err(error("create watch waker"));
        }
        Ok(Self {
            fd,
            waker: Waker(Arc::new(unsafe { OwnedFd::from_raw_fd(wake_fd) })),
            pending: HashMap::new(),
            watches: HashMap::new(),
        })
    }
    pub fn register(&mut self, id: u32, _: &str, pending: SharedPending, _: Notify) -> NativeResult<()> {
        self.pending.insert(id, pending);
        Ok(())
    }
    pub fn add(&mut self, id: u32, directory: &Directory) -> NativeResult<()> {
        let root = directory.root.as_str();
        let relative = directory.relative.as_str();
        let root_identity = directory.root_identity;
        let identity = directory.identity;

        if !self.pending.contains_key(&id) {
            return Err(native_error("EINVAL", "unknown watch registration"));
        }
        let root = CString::new(root).map_err(|_| native_error("EINVAL", "invalid watch root"))?;
        // SAFETY: valid NUL-terminated string. Identity, not this pathname, admits the fd.
        let root_fd = unsafe {
            libc::open(root.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        if root_fd < 0 {
            return Err(error("open watch root"));
        }
        let root_fd = unsafe { OwnedFd::from_raw_fd(root_fd) };
        let matches = |fd: &OwnedFd, expected: ExactFileIdentity| -> NativeResult<()> {
            let stat = rustix::fs::fstat(fd).map_err(|e| crate::unix::os_error(e, "stat watch directory"))?;
            if stat.st_dev != expected.dev || stat.st_ino != expected.ino {
                return Err(native_error("ESTALE", "watch directory identity changed"));
            }
            Ok(())
        };
        matches(&root_fd, root_identity)?;
        let directory = crate::unix::open_owned_beneath(
            root_fd.as_raw_fd(),
            relative,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )?;
        matches(&directory, identity)?;
        let namespace =
            rustix::fs::statfs("/proc/self/fd").map_err(|e| crate::unix::os_error(e, "verify procfs"))?;
        if namespace.f_type != 0x9fa0 {
            return Err(native_error("ENOTSUP", "watch requires a trusted procfs fd namespace"));
        }
        // The final /. selects the pinned directory, not the procfs magic symlink:
        // IN_DONT_FOLLOW|IN_ONLYDIR on the bare fd symlink would reject with ENOTDIR.
        let path = CString::new(format!("/proc/self/fd/{}/.", directory.as_raw_fd())).unwrap();
        let mask = libc::IN_ONLYDIR
            | libc::IN_DONT_FOLLOW
            | libc::IN_EXCL_UNLINK
            | libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_MODIFY
            | libc::IN_ATTRIB
            | libc::IN_CLOSE_WRITE
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF;
        let wd = unsafe { libc::inotify_add_watch(self.fd.as_raw_fd(), path.as_ptr(), mask) };
        if wd < 0 {
            return Err(error("register inotify directory"));
        }
        self.watches.entry(wd).or_default().entry(id).or_default().insert(relative.to_owned());
        // Re-registration replaces this owner's old inode without disturbing aliases or peers.
        let mut failure = None;
        self.watches.retain(|old_wd, owners| {
            if *old_wd == wd {
                return true;
            }
            if let Some(names) = owners.get_mut(&id) {
                names.remove(relative);
                if names.is_empty() {
                    owners.remove(&id);
                }
            }
            if !owners.is_empty() {
                return true;
            }
            if unsafe { libc::inotify_rm_watch(self.fd.as_raw_fd(), *old_wd) } < 0
                && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINVAL)
            {
                failure.get_or_insert_with(|| error("replace inotify watch"));
            }
            false
        });
        failure.map_or(Ok(()), Err) // inotify owns the inode reference; both opened descriptors close here.
    }
    pub fn remove(&mut self, id: u32) -> NativeResult<()> {
        self.pending.remove(&id);
        let mut failure = None;
        self.watches.retain(|wd, owners| {
            owners.remove(&id);
            if owners.is_empty() {
                if unsafe { libc::inotify_rm_watch(self.fd.as_raw_fd(), *wd) } < 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINVAL)
                {
                    failure.get_or_insert_with(|| error("remove inotify watch"));
                }
                false
            } else {
                true
            }
        });
        failure.map_or(Ok(()), Err)
    }
    fn overflow(&self) {
        for pending in self.pending.values() {
            pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).overflow();
        }
    }
    pub fn waker(&self) -> Waker {
        self.waker.clone()
    }
    pub fn wait(&mut self) {
        let mut fds = [
            libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: self.waker.0.as_raw_fd(), events: libc::POLLIN, revents: 0 },
        ];
        loop {
            let result = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if result >= 0 {
                break;
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                self.overflow();
                return;
            }
        }
        if fds[1].revents != 0 {
            let mut value = 0u64;
            // Read once: counter coalescing preserves wakes sent after this read.
            unsafe {
                libc::read(self.waker.0.as_raw_fd(), (&raw mut value).cast(), 8);
            }
        }
        if fds[0].revents != 0 {
            self.poll();
        }
    }
    fn poll(&mut self) {
        let mut buffer = [0u8; 65536];
        // Bound draining too: commands (especially joined removal) cannot starve.
        for _ in 0..16 {
            let count = unsafe { libc::read(self.fd.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
            if count < 0 {
                if std::io::Error::last_os_error().raw_os_error() != Some(libc::EAGAIN) {
                    self.overflow();
                }
                break;
            }
            if count == 0 {
                break;
            }
            let mut offset = 0;
            while offset + size_of::<libc::inotify_event>() <= count as usize {
                let event =
                    unsafe { buffer.as_ptr().add(offset).cast::<libc::inotify_event>().read_unaligned() };
                let start = offset + size_of::<libc::inotify_event>();
                let end = start + event.len as usize;
                if end > count as usize {
                    self.overflow();
                    break;
                }
                offset = end;
                if event.mask & libc::IN_Q_OVERFLOW != 0 {
                    self.overflow();
                    continue;
                }
                if let Some(owners) = self.watches.get(&event.wd) {
                    let bytes = &buffer[start..end];
                    let bytes = &bytes[..bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len())];
                    let name = std::str::from_utf8(bytes).ok().filter(|s| !s.is_empty());
                    for (id, directories) in owners {
                        if let Some(pending) = self.pending.get(id) {
                            let mut pending = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                            if let Some(name) = name {
                                for directory in directories {
                                    pending.push(
                                        directory.clone(),
                                        name.into(),
                                        event.mask
                                            & (libc::IN_CREATE
                                                | libc::IN_DELETE
                                                | libc::IN_MOVED_FROM
                                                | libc::IN_MOVED_TO)
                                            != 0,
                                    );
                                }
                            } else {
                                pending.overflow();
                            }
                        }
                    }
                } else {
                    self.overflow();
                }
                if event.mask & libc::IN_IGNORED != 0 {
                    self.watches.remove(&event.wd);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::MetadataExt;
    use std::sync::Mutex;

    #[test]
    fn replacement_retires_old_inode_but_preserves_other_owners() {
        let root = std::env::temp_dir().join(format!("fs-safe-watch-replace-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        let identity = |path: &std::path::Path| {
            let stat = fs::metadata(path).unwrap();
            ExactFileIdentity { dev: stat.dev(), ino: stat.ino() }
        };
        let mut backend = Backend::new().unwrap();
        for id in [1, 2] {
            backend.pending.insert(id, Arc::new(Mutex::new(super::super::Pending::default())));
        }
        let mut directory = Directory {
            root: root.to_str().unwrap().into(),
            relative: "child".into(),
            root_identity: identity(&root),
            identity: identity(&child),
            recursive: false,
        };
        backend.add(1, &directory).unwrap();
        backend.add(2, &directory).unwrap();
        for cycle in 0..3 {
            fs::rename(&child, root.join(format!("old-{cycle}"))).unwrap();
            fs::create_dir(&child).unwrap();
            directory.identity = identity(&child);
            backend.add(1, &directory).unwrap();
            assert_eq!(backend.watches.len(), 2);
            assert_eq!(backend.watches.values().filter(|owners| owners.contains_key(&1)).count(), 1);
            assert_eq!(backend.watches.values().filter(|owners| owners.contains_key(&2)).count(), 1);
        }
        backend.remove(1).unwrap();
        assert_eq!(backend.watches.len(), 1);
        backend.remove(2).unwrap();
        assert!(backend.watches.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
