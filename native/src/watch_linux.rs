use super::{Directory, SharedPending};
use crate::{ExactFileIdentity, NativeResult, native_error};
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

pub(super) struct Backend {
    fd: OwnedFd,
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
        Ok(Self { fd: unsafe { OwnedFd::from_raw_fd(fd) }, pending: HashMap::new(), watches: HashMap::new() })
    }
    pub fn register(&mut self, id: u32, _: &str, pending: SharedPending) -> NativeResult<()> {
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
        let root_fd =
            unsafe { libc::open(root.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
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
        let namespace = rustix::fs::statfs("/proc/self/fd").map_err(|e| crate::unix::os_error(e, "verify procfs"))?;
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
        Ok(()) // inotify owns the inode reference; both opened descriptors close here.
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
            pending.lock().unwrap().overflow();
        }
    }
    pub fn poll(&mut self) {
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
                let event = unsafe { buffer.as_ptr().add(offset).cast::<libc::inotify_event>().read_unaligned() };
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
                            let mut pending = pending.lock().unwrap();
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
