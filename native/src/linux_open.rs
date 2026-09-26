use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::sync::OnceLock;

use rustix::fs::{AtFlags, FileType, Mode, OFlags, ResolveFlags, Stat, openat, openat2};

use crate::unix::{borrowed, os_error};
use crate::{NativeResult, native_error};

static OPENAT2_AVAILABLE: OnceLock<bool> = OnceLock::new();

pub(crate) fn openat2_available() -> bool {
    *OPENAT2_AVAILABLE.get_or_init(|| {
        if std::env::var_os("FS_SAFE_TEST_NO_OPENAT2").is_some_and(|value| value == "1") {
            return false;
        }
        // Probe a harmless directory lookup, not an application pathname:
        // EPERM on an actual operation must never select a fallback.
        let probe = openat2(
            rustix::fs::CWD,
            ".",
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
        );
        !matches!(
            probe,
            Err(rustix::io::Errno::NOSYS | rustix::io::Errno::PERM)
        )
    })
}

fn matches_identity(left: &Stat, right: &Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && FileType::from_raw_mode(left.st_mode) == FileType::from_raw_mode(right.st_mode)
}

fn inspect(parent: i32, name: &str) -> NativeResult<Stat> {
    let stat = rustix::fs::statat(borrowed(parent), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect beneath component"))?;
    if FileType::from_raw_mode(stat.st_mode).is_symlink() {
        return Err(native_error(
            "ELOOP",
            "openat fallback rejects symlink components",
        ));
    }
    Ok(stat)
}

fn verify_entry(parent: i32, name: &str, child: i32) -> NativeResult<()> {
    let named = inspect(parent, name)?;
    let opened = rustix::fs::fstat(borrowed(child))
        .map_err(|error| os_error(error, "inspect opened beneath component"))?;
    if !matches_identity(&named, &opened) {
        return Err(native_error(
            "EXDEV",
            "beneath component changed during openat walk",
        ));
    }
    Ok(())
}

fn verify_chain(root: i32, directories: &[(&str, OwnedFd)]) -> NativeResult<()> {
    let mut parent = root;
    for (name, child) in directories {
        verify_entry(parent, name, child.as_raw_fd())?;
        parent = child.as_raw_fd();
    }
    Ok(())
}

pub(crate) fn open_fallback(
    root: i32,
    path: &str,
    flags: OFlags,
    mode: Mode,
) -> NativeResult<OwnedFd> {
    if flags.contains(OFlags::TMPFILE) {
        return Err(native_error(
            "ENOTSUP",
            "openat fallback does not support anonymous O_TMPFILE opens",
        ));
    }
    // Older openat kernels may create a regular file for CREATE | DIRECTORY.
    // Never trim a directory suffix into such a mutating basename request.
    if flags.contains(OFlags::CREATE)
        && (flags.contains(OFlags::DIRECTORY) || directory_suffix(path))
    {
        return Err(native_error(
            "EINVAL",
            "openat fallback cannot create a directory path",
        ));
    }
    open_fallback_with_hook(root, path, flags, mode, || {})
}

fn directory_suffix(path: &str) -> bool {
    path.ends_with('/') || path.ends_with("/.")
}

fn open_fallback_with_hook(
    root: i32,
    path: &str,
    flags: OFlags,
    mode: Mode,
    before_final: impl FnOnce(),
) -> NativeResult<OwnedFd> {
    // The caller validates the relative path and retained root descriptor.
    let mut components = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .peekable();
    let mut directories = Vec::new();
    let mut parent = root;
    while let Some(name) = components.next() {
        if components.peek().is_none() {
            before_final();
            verify_chain(root, &directories)?;
            let flags = flags
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC
                | if directory_suffix(path) {
                    OFlags::DIRECTORY
                } else {
                    OFlags::empty()
                };
            let opened = openat(borrowed(parent), name, flags, mode)
                .map_err(|error| os_error(error, "openat beneath root fallback"))?;
            // O_PATH | O_NOFOLLOW can open the symlink itself. It must not
            // bypass rejection, even though no link was followed.
            verify_entry(parent, name, opened.as_raw_fd())?;
            verify_chain(root, &directories)?;
            return Ok(opened);
        }
        verify_chain(root, &directories)?;
        let expected = inspect(parent, name)?;
        let child = openat(
            borrowed(parent),
            name,
            OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| os_error(error, "openat beneath directory fallback"))?;
        let actual = rustix::fs::fstat(child.as_fd())
            .map_err(|error| os_error(error, "inspect beneath directory fallback"))?;
        if !matches_identity(&expected, &actual) {
            return Err(native_error(
                "EXDEV",
                "beneath directory changed during openat walk",
            ));
        }
        parent = child.as_raw_fd();
        directories.push((name, child));
    }
    let opened = openat(
        borrowed(root),
        ".",
        flags | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode,
    )
    .map_err(|error| os_error(error, "openat retained root fallback"))?;
    verify_entry(root, ".", opened.as_raw_fd())?;
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn rejects_moved_parent_before_creating_file() {
        let dir = std::env::temp_dir().join(format!("fs-safe-openat-walk-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        for replacement_is_symlink in [true, false] {
            fs::create_dir(dir.join("root")).unwrap();
            fs::create_dir(dir.join("root/parent")).unwrap();
            let root = fs::File::open(dir.join("root")).unwrap();
            let error = open_fallback_with_hook(
                root.as_raw_fd(),
                "parent/created",
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
                Mode::RUSR | Mode::WUSR,
                || {
                    fs::rename(dir.join("root/parent"), dir.join("outside")).unwrap();
                    if replacement_is_symlink {
                        symlink(dir.join("outside"), dir.join("root/parent")).unwrap();
                    } else {
                        fs::create_dir(dir.join("root/parent")).unwrap();
                    }
                },
            )
            .unwrap_err();
            assert_eq!(
                error.status,
                if replacement_is_symlink {
                    "ELOOP"
                } else {
                    "EXDEV"
                }
            );
            assert!(!dir.join("outside/created").exists());
            fs::remove_dir_all(dir.join("root")).unwrap();
            fs::remove_dir_all(dir.join("outside")).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
