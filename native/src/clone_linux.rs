use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};

use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, Stat, Timestamps, XattrFlags};

use crate::unix::{
    borrowed, create_exclusive_target, open_beneath, open_cleanup_directory, os_error,
    remove_owned_tree,
};
use crate::{NativeResult, native_error};

const MAX_DEPTH: usize = 128;

fn stat(fd: i32) -> NativeResult<Stat> {
    rustix::fs::fstat(borrowed(fd)).map_err(|error| os_error(error, "inspect XFS clone entry"))
}

fn same_identity(left: &Stat, right: &Stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

fn unchanged(before: &Stat, after: &Stat) -> NativeResult<()> {
    if !same_identity(before, after)
        || before.st_mode != after.st_mode
        || before.st_size != after.st_size
        || before.st_mtime != after.st_mtime
        || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
    {
        return Err(native_error(
            "path-mismatch",
            "XFS clone source changed during cloning",
        ));
    }
    Ok(())
}

fn timestamps(metadata: &Stat) -> Timestamps {
    Timestamps {
        last_access: rustix::fs::Timespec {
            tv_sec: metadata.st_atime as _,
            tv_nsec: metadata.st_atime_nsec as _,
        },
        last_modification: rustix::fs::Timespec {
            tv_sec: metadata.st_mtime as _,
            tv_nsec: metadata.st_mtime_nsec as _,
        },
    }
}

fn xattr_names(fd: i32) -> NativeResult<Vec<CString>> {
    // Most entries have no attributes or a short ACL. Linux bounds the larger
    // list at 64 KiB; only allocate that buffer when the small one is full.
    let mut buffer = vec![0; 256];
    let length = match rustix::fs::flistxattr(borrowed(fd), buffer.as_mut_slice()) {
        Err(rustix::io::Errno::RANGE) => {
            buffer.resize(65_536, 0);
            rustix::fs::flistxattr(borrowed(fd), buffer.as_mut_slice())
        }
        result => result,
    }
    .map_err(|error| os_error(error, "list XFS clone extended attributes"))?;
    buffer.truncate(length);
    buffer
        .split_inclusive(|&byte| byte == 0)
        .map(|name| {
            CString::from_vec_with_nul(name.to_vec())
                .map_err(|_| native_error("EIO", "invalid extended attribute name list"))
        })
        .collect()
}

fn copy_metadata(source_fd: i32, target_fd: i32, metadata: &Stat) -> NativeResult<()> {
    let names = xattr_names(source_fd)?;
    for inherited in xattr_names(target_fd)? {
        if !names.contains(&inherited) {
            rustix::fs::fremovexattr(borrowed(target_fd), inherited.as_c_str())
                .map_err(|error| os_error(error, "remove inherited clone extended attribute"))?;
        }
    }
    // chmod can alter an access ACL's mask. Set the mode first, then install
    // the source ACL along with its other xattrs; default ACLs arrive only
    // after all children have been created.
    rustix::fs::fchmod(borrowed(target_fd), Mode::from_raw_mode(metadata.st_mode))
        .map_err(|error| os_error(error, "preserve XFS clone mode"))?;
    let mut value = vec![0; if names.is_empty() { 0 } else { 65_536 }];
    for name in names {
        let length =
            rustix::fs::fgetxattr(borrowed(source_fd), name.as_c_str(), value.as_mut_slice())
                .map_err(|error| os_error(error, "read XFS clone extended attribute"))?;
        rustix::fs::fsetxattr(
            borrowed(target_fd),
            name.as_c_str(),
            &value[..length],
            XattrFlags::empty(),
        )
        .map_err(|error| os_error(error, "preserve XFS clone extended attribute"))?;
    }
    rustix::fs::futimens(borrowed(target_fd), &timestamps(metadata))
        .map_err(|error| os_error(error, "preserve XFS clone timestamps"))?;
    unchanged(metadata, &stat(source_fd)?)
}

fn open_child(parent_fd: i32, name: &str, flags: OFlags) -> NativeResult<OwnedFd> {
    let fd = open_beneath(
        parent_fd,
        name,
        (flags | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
    )?;
    // open_beneath transfers ownership of its newly opened descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

struct FileJob {
    source_parent: Arc<OwnedFd>,
    target_parent: Arc<OwnedFd>,
    name: String,
    metadata: Stat,
}

fn clone_file(job: FileJob) -> NativeResult<()> {
    // NONBLOCK prevents an entry replaced by a FIFO from blocking admission.
    let source = open_child(
        job.source_parent.as_raw_fd(),
        &job.name,
        OFlags::RDONLY | OFlags::NONBLOCK,
    )?;
    let opened = stat(source.as_raw_fd())?;
    unchanged(&job.metadata, &opened)?;
    if !FileType::from_raw_mode(opened.st_mode).is_file() {
        return Err(native_error("path-mismatch", "XFS clone file changed type"));
    }
    let target = create_exclusive_target(job.target_parent.as_raw_fd(), &job.name)?;
    // This is deliberately the strict primitive: preserve its errno and never
    // fall back to byte copying, normalize permissions, or fsync each file.
    rustix::fs::ioctl_ficlone(&target, &source).map_err(|error| {
        if error == rustix::io::Errno::OPNOTSUPP {
            native_error(
                "CLONE_UNAVAILABLE",
                format!("clone XFS file extents: {error}"),
            )
        } else {
            os_error(error, "clone XFS file extents")
        }
    })?;
    copy_metadata(source.as_raw_fd(), target.as_raw_fd(), &job.metadata)
}

#[derive(Default)]
struct WorkState {
    pending: usize,
    error: Option<napi::Error<String>>,
}

struct Work<'a> {
    sender: mpsc::SyncSender<FileJob>,
    state: Arc<(Mutex<WorkState>, Condvar)>,
    cancelled: &'a AtomicBool,
}

impl Work<'_> {
    fn check(&self) -> NativeResult<()> {
        if let Some(error) = &self.state.0.lock().unwrap().error {
            return Err(native_error(error.status.clone(), error.reason.clone()));
        }
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(native_error("Cancelled", "directory cloning aborted"));
        }
        Ok(())
    }

    fn submit(&self, job: FileJob) -> NativeResult<()> {
        self.check()?;
        self.state.0.lock().unwrap().pending += 1;
        if self.sender.send(job).is_err() {
            self.state.0.lock().unwrap().pending -= 1;
            return Err(native_error("EIO", "XFS clone worker stopped"));
        }
        Ok(())
    }

    fn settle(&self) -> NativeResult<()> {
        let mut state = self.state.0.lock().unwrap();
        while state.pending != 0 {
            state = self.state.1.wait(state).unwrap();
        }
        drop(state);
        self.check()
    }
}

fn clone_symlink(
    source_parent: i32,
    target_parent: i32,
    name: &str,
    metadata: &Stat,
) -> NativeResult<()> {
    let source = open_child(source_parent, name, OFlags::PATH)?;
    unchanged(metadata, &stat(source.as_raw_fd())?)?;
    // O_PATH pins the link itself, so readlinkat never resolves its target.
    let target = rustix::fs::readlinkat(&source, "", Vec::new())
        .map_err(|error| os_error(error, "read XFS clone symbolic link"))?;
    // Linux does not provide f*xattr for O_PATH symlink descriptors. The only
    // path lookup here uses a pinned parent and a validated literal child,
    // with a no-follow operation and identity checks around it. Callers must
    // keep the source namespace immutable, as for the other clone backends.
    let proc_path = format!("/proc/self/fd/{source_parent}/{name}");
    let mut attributes = [0u8; 1];
    match rustix::fs::llistxattr(proc_path.as_str(), &mut attributes[..]) {
        Ok(0) => {}
        Ok(_) | Err(rustix::io::Errno::RANGE) => {
            return Err(native_error(
                "ENOTSUP",
                "XFS cloning cannot preserve symbolic-link extended attributes",
            ));
        }
        Err(error) => return Err(os_error(error, "inspect symbolic-link extended attributes")),
    }
    let current = rustix::fs::statat(borrowed(source_parent), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "reinspect XFS clone symbolic link"))?;
    unchanged(metadata, &current)?;
    rustix::fs::symlinkat(target.as_c_str(), borrowed(target_parent), name)
        .map_err(|error| os_error(error, "create XFS clone symbolic link"))?;
    rustix::fs::utimensat(
        borrowed(target_parent),
        name,
        &timestamps(metadata),
        AtFlags::SYMLINK_NOFOLLOW,
    )
    .map_err(|error| os_error(error, "preserve XFS clone symbolic-link timestamps"))?;
    unchanged(metadata, &stat(source.as_raw_fd())?)
}

fn walk(
    source: Arc<OwnedFd>,
    target: Arc<OwnedFd>,
    work: &Work<'_>,
    depth: usize,
) -> NativeResult<()> {
    work.check()?;
    if depth > MAX_DEPTH {
        return Err(native_error(
            "ENAMETOOLONG",
            "XFS clone directory nesting exceeds 128 levels",
        ));
    }
    let metadata = stat(source.as_raw_fd())?;
    let mut directory = Dir::read_from(&source)
        .map_err(|error| os_error(error, "open XFS clone directory stream"))?;
    for entry in &mut directory {
        work.check()?;
        let entry = entry.map_err(|error| os_error(error, "read XFS clone directory entry"))?;
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        let name_str = name
            .to_str()
            .map_err(|_| native_error("ENOTSUP", "XFS clone names must be valid UTF-8"))?;
        let child = rustix::fs::statat(&source, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| os_error(error, "inspect XFS clone child"))?;
        if child.st_dev != metadata.st_dev {
            return Err(native_error(
                "EXDEV",
                "XFS clone source contains another filesystem",
            ));
        }
        if child.st_ino as u64 != entry.ino() {
            return Err(native_error(
                "path-mismatch",
                "XFS clone entry changed after enumeration",
            ));
        }
        match FileType::from_raw_mode(child.st_mode) {
            FileType::Directory => {
                let opened = open_cleanup_directory(source.as_raw_fd(), name)?;
                unchanged(&child, &stat(opened.as_raw_fd())?)?;
                rustix::fs::mkdirat(&target, name, Mode::from_bits_retain(0o700))
                    .map_err(|error| os_error(error, "create XFS clone child directory"))?;
                let created = open_cleanup_directory(target.as_raw_fd(), name)?;
                walk(Arc::new(opened), Arc::new(created), work, depth + 1)?;
            }
            FileType::RegularFile => work.submit(FileJob {
                source_parent: Arc::clone(&source),
                target_parent: Arc::clone(&target),
                name: name_str.to_owned(),
                metadata: child,
            })?,
            FileType::Symlink => {
                clone_symlink(source.as_raw_fd(), target.as_raw_fd(), name_str, &child)?
            }
            _ => {
                return Err(native_error(
                    "ENOTSUP",
                    "XFS cloning supports regular files, directories, and symbolic links",
                ));
            }
        }
    }
    // A directory's mtime and default ACL must be installed after its children
    // settle. Holding only the traversal stack and bounded queue limits FDs.
    work.settle()?;
    copy_metadata(source.as_raw_fd(), target.as_raw_fd(), &metadata)
}

fn prepare_cleanup(directory_fd: i32, depth: usize) -> NativeResult<()> {
    if depth > MAX_DEPTH + 1 {
        return Err(native_error(
            "ENAMETOOLONG",
            "XFS clone cleanup nesting exceeded",
        ));
    }
    rustix::fs::fchmod(borrowed(directory_fd), Mode::from_bits_retain(0o700))
        .map_err(|error| os_error(error, "restore owned clone cleanup permissions"))?;
    let mut directory = Dir::read_from(borrowed(directory_fd))
        .map_err(|error| os_error(error, "open XFS clone cleanup directory"))?;
    for entry in &mut directory {
        let entry = entry.map_err(|error| os_error(error, "read XFS clone cleanup entry"))?;
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        let current = rustix::fs::statat(borrowed(directory_fd), name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| os_error(error, "inspect XFS clone cleanup entry"))?;
        if !FileType::from_raw_mode(current.st_mode).is_dir() {
            continue;
        }
        if current.st_ino as u64 != entry.ino() {
            return Err(native_error(
                "path-mismatch",
                "XFS clone cleanup entry changed",
            ));
        }
        let child = open_cleanup_directory(directory_fd, name)?;
        if !same_identity(&current, &stat(child.as_raw_fd())?) {
            return Err(native_error(
                "path-mismatch",
                "XFS clone cleanup directory changed",
            ));
        }
        prepare_cleanup(child.as_raw_fd(), depth + 1)?;
    }
    Ok(())
}

pub fn clone_tree(
    source_fd: i32,
    parent_fd: i32,
    basename: &str,
    cancelled: &AtomicBool,
    concurrency: usize,
) -> NativeResult<()> {
    if stat(source_fd)?.st_dev != stat(parent_fd)?.st_dev {
        return Err(native_error(
            "EXDEV",
            "XFS clone source and destination must share a filesystem",
        ));
    }
    let source = Arc::new(open_cleanup_directory(source_fd, c".")?);
    rustix::fs::mkdirat(borrowed(parent_fd), basename, Mode::from_bits_retain(0o700))
        .map_err(|error| os_error(error, "create XFS clone destination"))?;
    let name = CString::new(basename)
        .map_err(|_| native_error("EINVAL", "clone destination contains a NUL byte"))?;
    let target = Arc::new(open_cleanup_directory(parent_fd, name.as_c_str())?);
    let concurrency = concurrency.clamp(1, 32);
    let (sender, receiver) = mpsc::sync_channel::<FileJob>(concurrency * 2);
    let receiver = Arc::new(Mutex::new(receiver));
    let state = Arc::new((Mutex::new(WorkState::default()), Condvar::new()));
    let result = std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..concurrency {
            let receiver = Arc::clone(&receiver);
            let state = Arc::clone(&state);
            let worker = std::thread::Builder::new().spawn_scoped(scope, move || {
                loop {
                    let Ok(job) = receiver.lock().unwrap().recv() else {
                        break;
                    };
                    let skip = cancelled.load(Ordering::Relaxed)
                        || state.0.lock().unwrap().error.is_some();
                    let result = if skip {
                        Ok(())
                    } else {
                        std::panic::catch_unwind(|| clone_file(job)).unwrap_or_else(|_| {
                            Err(native_error("EIO", "XFS clone worker panicked"))
                        })
                    };
                    let mut current = state.0.lock().unwrap();
                    if current.error.is_none() {
                        current.error = result.err();
                    }
                    current.pending -= 1;
                    state.1.notify_all();
                }
            });
            match worker {
                Ok(worker) => workers.push(worker),
                Err(error) => {
                    drop(sender);
                    for worker in workers {
                        let _ = worker.join();
                    }
                    return Err(native_error(
                        "EIO",
                        format!("start XFS clone worker: {error}"),
                    ));
                }
            }
        }
        let work = Work {
            sender,
            state,
            cancelled,
        };
        let result = walk(source, Arc::clone(&target), &work, 0);
        // Even an early traversal error must settle every admitted write before
        // metadata recovery or removal touches the owned destination.
        let settled = work.settle();
        drop(work);
        let mut joined = Ok(());
        for worker in workers {
            if worker.join().is_err() {
                joined = Err(native_error("EIO", "XFS clone worker panicked"));
            }
        }
        result.and(settled).and(joined)
    });
    if let Err(error) = result {
        let cleanup = prepare_cleanup(target.as_raw_fd(), 0)
            .and_then(|()| remove_owned_tree(parent_fd, basename, target.as_raw_fd()));
        return match cleanup {
            Ok(outcome) if outcome == "removed" => Err(error),
            Ok(_) => Err(native_error(
                error.status,
                format!(
                    "{}; clone destination changed and was preserved",
                    error.reason
                ),
            )),
            Err(cleanup) => Err(native_error(
                error.status,
                format!("{}; clone cleanup failed: {}", error.reason, cleanup.reason),
            )),
        };
    }
    Ok(())
}
