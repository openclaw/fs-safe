use rustix::fs::{AtFlags, FileType, Stat};
use crate::{ExactFileIdentity, NativeResult, native_error};
use crate::unix::{borrowed, nonnegative_fd, os_error};

#[cfg(test)]
thread_local! {
    pub(crate) static BEFORE_RENAME: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
    pub(crate) static BEFORE_LINK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
    pub(crate) static BEFORE_UNLINK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
    pub(crate) static AFTER_UNLINK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
}

fn inspect(fd: i32, name: &str) -> NativeResult<Stat> {
    rustix::fs::statat(borrowed(fd), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect no-replace move fallback"))
}

fn verify(stat: &Stat, expected: &ExactFileIdentity, kind: FileType, links: u64) -> NativeResult<()> {
    if stat.st_dev != expected.dev || stat.st_ino != expected.ino ||
        FileType::from_raw_mode(stat.st_mode) != kind {
        return Err(native_error("path-mismatch", "no-replace move fallback identity changed"));
    }
    // Linux exposes a 32-bit link count on aarch64 and 64-bit on x86_64.
    #[allow(clippy::unnecessary_cast)]
    if kind == FileType::RegularFile && stat.st_nlink as u64 != links {
        return Err(native_error("hardlink", "no-replace move fallback link count changed"));
    }
    Ok(())
}

// Called only after TypeScript admits an unsupported capability in auto mode.
// Both names are direct children of the caller's retained, checked parents.
pub(crate) fn move_fallback(
    source_fd: i32, source: &str, target_fd: i32, target: &str,
    expected: ExactFileIdentity,
) -> NativeResult<()> {
    nonnegative_fd(source_fd, "no-replace move fallback source")?;
    nonnegative_fd(target_fd, "no-replace move fallback target")?;
    crate::validate_child_basename(source)?;
    crate::validate_child_basename(target)?;
    let source_stat = inspect(source_fd, source)?;
    let kind = FileType::from_raw_mode(source_stat.st_mode);
    if kind == FileType::Symlink {
        return Err(native_error("ELOOP", "no-replace move fallback refuses a symlink"));
    }
    if !matches!(kind, FileType::RegularFile | FileType::Directory) {
        return Err(native_error("not-file", "no-replace move fallback requires a file or directory"));
    }
    verify(&source_stat, &expected, kind, 1)?;
    match rustix::fs::statat(borrowed(target_fd), target, AtFlags::SYMLINK_NOFOLLOW) {
        Err(rustix::io::Errno::NOENT) => {}
        Ok(_) => return Err(native_error("EEXIST", "no-replace move fallback destination exists")),
        Err(error) => return Err(os_error(error, "inspect no-replace move fallback destination")),
    }
    if kind == FileType::Directory {
        verify(&inspect(source_fd, source)?, &expected, kind, 1)?;
        #[cfg(test)]
        BEFORE_RENAME.with(|hook| { if let Some(hook) = hook.borrow_mut().take() { hook(); } });
        // rename(2) of a directory onto an existing name succeeds only for an
        // EMPTY directory: non-empty gives ENOTEMPTY, non-directory ENOTDIR.
        // A trailing slash also requires the source dentry to remain a directory;
        // rename never follows a final symlink. This prevents a substituted file
        // from clobbering another file. Identity is still not a syscall condition.
        rustix::fs::renameat(borrowed(source_fd), format!("{source}/"), borrowed(target_fd), target)
            .map_err(|error| match error {
                rustix::io::Errno::NOTEMPTY | rustix::io::Errno::NOTDIR | rustix::io::Errno::EXIST =>
                    native_error("EEXIST", "renameat directory fallback destination exists"),
                error => os_error(error, "renameat directory fallback after unsupported RENAME_NOREPLACE"),
            })?;
        return verify(&inspect(target_fd, target)?, &expected, kind, 1);
    }
    // No AT_SYMLINK_FOLLOW: a substituted symlink is never dereferenced.
    #[cfg(test)]
    BEFORE_LINK.with(|hook| { if let Some(hook) = hook.borrow_mut().take() { hook(); } });
    rustix::fs::linkat(borrowed(source_fd), source, borrowed(target_fd), target, AtFlags::empty())
        .map_err(|error| match error {
            rustix::io::Errno::PERM | rustix::io::Errno::NOTSUP | rustix::io::Errno::MLINK |
            rustix::io::Errno::XDEV | rustix::io::Errno::NOSYS => native_error(
                "FS_SAFE_INTERNAL_MOVE_LINK_UNSUPPORTED",
                format!("renameat2 RENAME_NOREPLACE unavailable; linkat file move fallback unavailable: {error}")),
            error => os_error(error, "linkat file move fallback after unsupported RENAME_NOREPLACE"),
        })?;
    let verify_pair = || -> NativeResult<()> {
        // Exactly this two-name interval permits nlink=2; admission and final
        // publication still require nlink=1. Never remove an unverified name.
        verify(&inspect(target_fd, target)?, &expected, kind, 2)?;
        verify(&inspect(source_fd, source)?, &expected, kind, 2)
    };
    #[cfg(test)]
    BEFORE_UNLINK.with(|hook| { if let Some(hook) = hook.borrow_mut().take() { hook(); } });
    verify_pair().map_err(|error| native_error("FS_SAFE_INTERNAL_MOVE_LINK_CHANGED",
        format!("linkat file move fallback published target; source unlink not attempted: {}", error.reason)))?;
    if let Err(error) = rustix::fs::unlinkat(borrowed(source_fd), source, AtFlags::empty()) {
        // Do not roll back the target: it may be the only remaining source link.
        let linked = verify_pair().is_ok();
        return Err(native_error(
            if linked { "FS_SAFE_INTERNAL_MOVE_SOURCE_LINKED" } else { "FS_SAFE_INTERNAL_MOVE_UNLINK_UNVERIFIED" },
            format!("linkat file move fallback published target; {}: {}",
                if linked { "source still linked" } else { "source removal unverified" },
                os_error(error, "unlinkat source").reason)));
    }
    #[cfg(test)]
    AFTER_UNLINK.with(|hook| { if let Some(hook) = hook.borrow_mut().take() { hook(); } });
    inspect(target_fd, target).and_then(|stat| verify(&stat, &expected, kind, 1))
        .map_err(|error| native_error("FS_SAFE_INTERNAL_MOVE_PUBLISHED",
            format!("linkat/unlinkat file move fallback completed; target verification failed: {}", error.reason)))
}
