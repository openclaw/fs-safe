//! Descriptor-bound, nonrecursive transport for admitted entry scopes.
use super::super::{SharedPending, WatchEntriesResult, WatchEntryRegistration, unix_error as error};
use crate::{ExactFileIdentity, NativeResult, native_error};
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::Arc;

const NOTES: u32 = libc::NOTE_WRITE
    | libc::NOTE_EXTEND
    | libc::NOTE_ATTRIB
    | libc::NOTE_DELETE
    | libc::NOTE_RENAME
    | libc::NOTE_REVOKE
    | libc::NOTE_LINK;

fn event(ident: usize, filter: i16, flags: u16, fflags: u32) -> libc::kevent {
    libc::kevent { ident, filter, flags, fflags, data: 0, udata: std::ptr::null_mut() }
}
fn change(fd: i32, change: libc::kevent) -> NativeResult<()> {
    loop {
        if unsafe { libc::kevent(fd, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) } == 0 {
            return Ok(());
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err(error("configure kqueue watch"));
        }
    }
}
#[derive(Clone)]
pub(crate) struct Waker(Arc<OwnedFd>);
impl Waker {
    pub fn wake(&self) {
        let _ = change(self.0.as_raw_fd(), event(0, libc::EVFILT_USER, 0, libc::NOTE_TRIGGER));
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Spec {
    root: String,
    root_identity: ExactFileIdentity,
    directory: String,
    parent_identity: ExactFileIdentity,
    name: String,
    identity: ExactFileIdentity,
    kind: String,
    target: bool,
}
struct Watch {
    fd: OwnedFd,
    spec: Spec,
    pending: SharedPending,
}
type Key = (u32, String, bool);
pub(super) struct Queue {
    waker: Waker,
    watches: HashMap<Key, Watch>,
}
fn matches(fd: &OwnedFd, expected: ExactFileIdentity) -> NativeResult<()> {
    let stat = rustix::fs::fstat(fd).map_err(|e| crate::unix::os_error(e, "stat kqueue descriptor"))?;
    if stat.st_dev as u64 != expected.dev || stat.st_ino != expected.ino {
        return Err(native_error("ESTALE", "kqueue descriptor identity changed"));
    }
    Ok(())
}
fn opened(fd: i32) -> NativeResult<OwnedFd> {
    if fd < 0 { Err(error("open kqueue descriptor")) } else { Ok(unsafe { OwnedFd::from_raw_fd(fd) }) }
}
fn open(spec: &Spec) -> NativeResult<OwnedFd> {
    let root = CString::new(spec.root.as_str()).map_err(|_| native_error("EINVAL", "invalid watch root"))?;
    let flags = libc::O_EVTONLY | libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC;
    let root = opened(unsafe { libc::open(root.as_ptr(), flags) })?;
    matches(&root, spec.root_identity)?;
    // Walk only literal directory components. No intermediate symlink is followed.
    let mut parent = root;
    if !spec.directory.is_empty() {
        for segment in spec.directory.split('/') {
            let segment = CString::new(segment).unwrap(); // validated before admission
            parent = opened(unsafe { libc::openat(parent.as_raw_fd(), segment.as_ptr(), flags) })?;
        }
    }
    matches(&parent, spec.parent_identity)?;
    if !spec.target {
        return Ok(parent);
    }
    let name = CString::new(spec.name.as_str()).unwrap();
    // O_SYMLINK opens the link itself; combining it with O_NOFOLLOW returns ELOOP.
    let flags = libc::O_EVTONLY
        | libc::O_CLOEXEC
        | match spec.kind.as_str() {
            "symlink" => libc::O_SYMLINK,
            "directory" => libc::O_NOFOLLOW | libc::O_DIRECTORY,
            _ => libc::O_NOFOLLOW,
        };
    let target = opened(unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) })?;
    matches(&target, spec.identity)?;
    Ok(target)
}
impl Queue {
    pub fn new() -> NativeResult<Self> {
        let fd = opened(unsafe { libc::kqueue() })?;
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(error("set kqueue close-on-exec"));
        }
        change(fd.as_raw_fd(), event(0, libc::EVFILT_USER, libc::EV_ADD | libc::EV_CLEAR, 0))?;
        Ok(Self { waker: Waker(Arc::new(fd)), watches: HashMap::new() })
    }
    pub fn waker(&self) -> Waker {
        self.waker.clone()
    }
    pub fn configure(
        &mut self,
        id: u32,
        root: &str,
        entries: Vec<WatchEntryRegistration>,
        pending: SharedPending,
    ) -> NativeResult<WatchEntriesResult> {
        if entries.len() > 128 {
            return Err(native_error("EINVAL", "too many kqueue entry scopes"));
        }
        let mut desired = HashMap::new();
        let mut scopes = HashSet::new();
        for entry in entries {
            crate::validate_relative_path(&entry.scope, true)?;
            crate::validate_relative_path(&entry.directory.relative, true)?;
            if entry.directory.root != root
                || !scopes.insert(entry.scope.clone())
                || entry.name.contains('/')
                || entry.name == "."
                || entry.name == ".."
                || entry.name.contains('\0')
            {
                return Err(native_error("EINVAL", "invalid kqueue entry registration"));
            }
            let parent_identity = crate::exact_file_identity(&entry.directory.dev, &entry.directory.ino)?;
            let spec = Spec {
                root: root.into(),
                root_identity: crate::exact_file_identity(
                    &entry.directory.root_dev,
                    &entry.directory.root_ino,
                )?,
                directory: entry.directory.relative,
                parent_identity,
                name: String::new(),
                identity: parent_identity,
                kind: "directory".into(),
                target: false,
            };
            desired.insert((id, entry.scope.clone(), false), spec.clone());
            if let Some(target) = entry.target {
                if entry.name.is_empty()
                    || !["file", "directory", "symlink", "other"].contains(&target.kind.as_str())
                {
                    return Err(native_error("EINVAL", "invalid kqueue entry target"));
                }
                desired.insert(
                    (id, entry.scope, true),
                    Spec {
                        name: entry.name,
                        identity: crate::exact_file_identity(&target.dev, &target.ino)?,
                        kind: target.kind,
                        target: true,
                        ..spec
                    },
                );
            }
        }
        let mut changed = false;
        // Close obsolete descriptors before acquiring replacements, preserving the budget.
        // The caller performs another guarded scan after any change to close the handover gap.
        self.watches.retain(|key, watch| {
            let keep = key.0 != id || desired.get(key) == Some(&watch.spec);
            changed |= !keep;
            keep
        });
        for (key, spec) in desired {
            if let Some(watch) = self.watches.get(&key) {
                matches(&watch.fd, spec.identity)?;
                continue;
            }
            let fd = open(&spec)?;
            change(
                self.waker.0.as_raw_fd(),
                event(fd.as_raw_fd() as usize, libc::EVFILT_VNODE, libc::EV_ADD | libc::EV_CLEAR, NOTES),
            )?;
            self.watches.insert(key, Watch { fd, spec, pending: pending.clone() });
            changed = true;
        }
        Ok(WatchEntriesResult {
            changed,
            directories: self.watches.keys().filter(|key| key.0 == id).count() as u32,
        })
    }
    pub fn remove(&mut self, id: u32) {
        self.watches.retain(|key, _| key.0 != id);
    }
    pub fn wait(&mut self) {
        let mut events = [event(0, 0, 0, 0); 128];
        let count = loop {
            let count = unsafe {
                libc::kevent(
                    self.waker.0.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    events.len() as i32,
                    std::ptr::null(),
                )
            };
            if count >= 0 {
                break count as usize;
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                for watch in self.watches.values() {
                    watch.pending.lock().unwrap_or_else(|p| p.into_inner()).error = Some("EIO".into());
                }
                return;
            }
        };
        for event in &events[..count] {
            if event.filter != libc::EVFILT_VNODE {
                continue;
            }
            let Some(watch) =
                self.watches.values().find(|watch| watch.fd.as_raw_fd() as usize == event.ident)
            else {
                continue;
            };
            let mut pending = watch.pending.lock().unwrap_or_else(|p| p.into_inner());
            if event.flags & libc::EV_ERROR != 0 || matches(&watch.fd, watch.spec.identity).is_err() {
                pending.error = Some("ESTALE".into());
                continue;
            }
            let spec = &watch.spec;
            let structural = event.fflags & (libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE) != 0;
            // Directory child activity is a rescan, not a change to an entry-only directory.
            let detail = spec.target
                && (spec.kind != "directory" || structural || event.fflags & libc::NOTE_ATTRIB != 0);
            if detail {
                pending.push(spec.directory.clone(), spec.name.clone(), structural, None);
            } else {
                pending.rescan = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::{Pending, WatchDirectory, WatchEntryTarget};
    use std::fs;
    use std::os::unix::fs::{MetadataExt, symlink};
    use std::sync::Mutex;

    fn entry(root: &std::path::Path) -> WatchEntryRegistration {
        let parent = fs::metadata(root).unwrap();
        WatchEntryRegistration {
            scope: "entry".into(),
            name: "entry".into(),
            directory: WatchDirectory {
                root: root.to_str().unwrap().into(),
                relative: String::new(),
                root_dev: parent.dev().into(),
                root_ino: parent.ino().into(),
                dev: parent.dev().into(),
                ino: parent.ino().into(),
            },
            target: fs::symlink_metadata(root.join("entry")).ok().map(|stat| WatchEntryTarget {
                dev: stat.dev().into(),
                ino: stat.ino().into(),
                kind: if stat.is_symlink() { "symlink" } else { "file" }.into(),
            }),
        }
    }
    #[test]
    fn registration_rearms_replacements_and_removal_closes_descriptors() {
        let root = std::env::temp_dir().join(format!("fs-safe-kqueue-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let pending = Arc::new(Mutex::new(Pending { limit: 32, ..Pending::default() }));
        let mut queue = Queue::new().unwrap();
        let configure = |queue: &mut Queue| {
            queue.configure(1, root.to_str().unwrap(), vec![entry(&root)], pending.clone()).unwrap()
        };
        assert_eq!(configure(&mut queue).directories, 1);
        fs::write(root.join("entry"), "first").unwrap();
        queue.waker().wake();
        queue.wait();
        let batch = pending.lock().unwrap().take().unwrap();
        assert!(!batch.overflow && batch.hints.is_empty());
        assert_eq!(configure(&mut queue).directories, 2);
        assert!(!configure(&mut queue).changed);
        fs::write(root.join("entry"), "changed").unwrap();
        queue.waker().wake();
        queue.wait();
        assert!(pending.lock().unwrap().take().unwrap().hints.iter().any(|hint| hint.name == "entry"));
        fs::rename(root.join("entry"), root.join("old")).unwrap();
        fs::write(root.join("entry"), "replacement").unwrap();
        assert!(configure(&mut queue).changed);
        queue.waker().wake();
        queue.wait();
        pending.lock().unwrap().take();
        fs::write(root.join("old"), "retired inode").unwrap();
        queue.waker().wake();
        queue.wait();
        assert!(pending.lock().unwrap().take().is_none());
        fs::remove_file(root.join("entry")).unwrap();
        symlink("outside-not-followed", root.join("entry")).unwrap();
        assert_eq!(configure(&mut queue).directories, 2);
        let link = queue.watches.get(&(1, "entry".into(), true)).unwrap();
        assert_eq!(rustix::fs::fstat(&link.fd).unwrap().st_mode & libc::S_IFMT, libc::S_IFLNK);
        let descriptors: Vec<_> = queue.watches.values().map(|watch| watch.fd.as_raw_fd()).collect();
        queue.remove(1);
        assert!(queue.watches.is_empty());
        for fd in descriptors {
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        }
        queue.waker().wake();
        queue.wait();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mismatched_admission_and_scope_budget_fail_closed() {
        let root = std::env::temp_dir().join(format!("fs-safe-kqueue-identity-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let pending = Arc::new(Mutex::new(Pending::default()));
        let mut queue = Queue::new().unwrap();
        let mut wrong = entry(&root);
        wrong.directory.ino = 0u64.into();
        assert!(queue.configure(1, root.to_str().unwrap(), vec![wrong], pending.clone()).is_err());
        assert!(queue.watches.is_empty());
        assert!(
            queue
                .configure(1, root.to_str().unwrap(), (0..129).map(|_| entry(&root)).collect(), pending)
                .is_err()
        );
        assert!(queue.watches.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
