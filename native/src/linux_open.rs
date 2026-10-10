use std::collections::VecDeque;
use std::ffi::{CStr, CString};
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

fn changed() -> crate::NativeError {
    native_error("EXDEV", "beneath component changed during openat walk")
}

fn verify_entry(parent: i32, name: &CStr, child: i32) -> NativeResult<FileType> {
    let named = rustix::fs::statat(borrowed(parent), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|_| changed())?;
    let opened = rustix::fs::fstat(borrowed(child))
        .map_err(|error| os_error(error, "inspect opened beneath component"))?;
    if !matches_identity(&named, &opened) {
        return Err(changed());
    }
    Ok(FileType::from_raw_mode(opened.st_mode))
}

struct Directory {
    parent: i32,
    name: CString,
    fd: OwnedFd,
}

struct Link {
    parent: i32,
    name: CString,
    fd: OwnedFd,
    target: CString,
}

fn admit_symlink(parent: i32, link: i32) -> NativeResult<()> {
    let filesystem = rustix::fs::fstatfs(borrowed(link))
        .map_err(|error| os_error(error, "inspect symlink filesystem"))?;
    // ST_NOSYMFOLLOW (Linux UAPI) is not yet exposed by rustix. readlink is
    // allowed on these mounts, but manually following its result is not.
    const ST_NOSYMFOLLOW: u64 = 0x2000;
    if filesystem.f_flags as u64 & ST_NOSYMFOLLOW != 0
        || filesystem.f_type == rustix::fs::PROC_SUPER_MAGIC
    {
        return Err(native_error(
            "ELOOP",
            "openat fallback refuses procfs or nosymfollow links",
        ));
    }
    let directory = rustix::fs::fstat(borrowed(parent))
        .map_err(|error| os_error(error, "inspect symlink parent"))?;
    // Conservatively preserve protected_symlinks: mapped stat UIDs can hide
    // distinct owners, and a thread's fsuid need not equal its effective UID.
    if directory.st_mode & (libc::S_ISVTX | libc::S_IWOTH) == (libc::S_ISVTX | libc::S_IWOTH) {
        return Err(native_error(
            "EACCES",
            "openat fallback refuses links in sticky shared directories",
        ));
    }
    Ok(())
}

fn verify_walk(directories: &[Directory], links: &[Link]) -> NativeResult<()> {
    // Retain and verify even directories popped by a link's `..` target.
    for directory in directories {
        verify_entry(directory.parent, &directory.name, directory.fd.as_raw_fd())?;
    }
    for link in links {
        admit_symlink(link.parent, link.fd.as_raw_fd())?;
        verify_entry(link.parent, &link.name, link.fd.as_raw_fd())?;
        let target = rustix::fs::readlinkat(borrowed(link.parent), &link.name, Vec::new())
            .map_err(|_| changed())?;
        if target != link.target {
            return Err(changed());
        }
        verify_entry(link.parent, &link.name, link.fd.as_raw_fd())?;
    }
    Ok(())
}

fn components(path: &[u8]) -> VecDeque<CString> {
    // Keep dots and a trailing-slash marker: both require a directory, but
    // creation rejects the slash before looking up its final basename.
    let mut parts: VecDeque<_> = path
        .split(|byte| *byte == b'/')
        .filter(|part| !part.is_empty())
        .map(|part| CString::new(part).expect("validated path or kernel link target"))
        .collect();
    if path.ends_with(b"/") {
        parts.push_back(CString::new("").unwrap());
    }
    parts
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
    if flags.contains(OFlags::CREATE | OFlags::DIRECTORY) {
        return Err(native_error(
            "EINVAL",
            "openat fallback cannot create a directory path",
        ));
    }
    open_fallback_with_hook(root, path, flags, mode, || {})
}

fn open_fallback_with_hook(
    root: i32,
    path: &str,
    flags: OFlags,
    mode: Mode,
    before_final: impl FnOnce(),
) -> NativeResult<OwnedFd> {
    // The caller validates the relative path and retained root descriptor.
    if path.as_bytes().contains(&0) {
        return Err(native_error("EINVAL", "beneath path contains NUL"));
    }
    if path.len() >= libc::PATH_MAX as usize {
        return Err(native_error("ENAMETOOLONG", "beneath path is too long"));
    }
    let mut pending = components(path.as_bytes());
    let mut directories = Vec::new();
    let mut stack = vec![root];
    let mut links = Vec::new();
    let (parent, name, expected, require_directory) = loop {
        let name = pending
            .pop_front()
            .filter(|name| !name.as_bytes().is_empty())
            .unwrap_or_else(|| CString::new(".").unwrap());
        let trailing_slash = pending.len() == 1 && pending[0].as_bytes().is_empty();
        if flags.contains(OFlags::CREATE) && trailing_slash {
            openat(
                borrowed(*stack.last().unwrap()),
                ".",
                OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| os_error(error, "search trailing-slash parent"))?;
            return Err(native_error(
                "EISDIR",
                "cannot create a trailing-slash path",
            ));
        }
        if name.as_bytes() == b".." {
            // O_PATH can retain an unsearchable directory; interpreting `..`
            // still requires the kernel's search permission check on it.
            openat(
                borrowed(*stack.last().unwrap()),
                ".",
                OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| os_error(error, "search beneath parent"))?;
            if stack.len() == 1 {
                return Err(native_error(
                    "EXDEV",
                    "symlink target escapes retained root",
                ));
            }
            stack.pop();
            if pending.is_empty() {
                pending.push_back(CString::new(".").unwrap());
            }
            continue;
        }
        let parent = *stack.last().unwrap();
        verify_walk(&directories, &links)?;
        let final_component = pending.is_empty() || trailing_slash;
        let exclusive =
            flags.contains(OFlags::CREATE | OFlags::EXCL) && !flags.contains(OFlags::PATH);
        if final_component && !trailing_slash && exclusive {
            // EXCL never follows a link. Probing the contested leaf first can
            // turn ordinary disappearance/replacement into a spurious EXDEV.
            // The final open and its post-create identity fence own this entry.
            break (parent, name, None, false);
        }
        let child = match openat(
            borrowed(parent),
            &name,
            OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(child) => child,
            Err(rustix::io::Errno::NOENT) if final_component && flags.contains(OFlags::CREATE) => {
                break (parent, name, None, trailing_slash);
            }
            Err(error) => return Err(os_error(error, "inspect beneath component")),
        };
        let kind = verify_entry(parent, &name, child.as_raw_fd())?;
        if kind.is_symlink()
            && !(final_component && !trailing_slash && flags.contains(OFlags::NOFOLLOW))
        {
            admit_symlink(parent, child.as_raw_fd())?;
            if links.len() == 40 {
                return Err(native_error("ELOOP", "too many symlink expansions"));
            }
            let target = rustix::fs::readlinkat(child.as_fd(), "", Vec::new())
                .map_err(|error| os_error(error, "read beneath symlink"))?;
            if target.as_bytes().starts_with(b"/") {
                return Err(native_error(
                    "EXDEV",
                    "absolute symlink target escapes retained root",
                ));
            }
            let mut expanded = components(target.as_bytes());
            if expanded
                .back()
                .is_some_and(|part| part.as_bytes().is_empty())
                && pending
                    .front()
                    .is_some_and(|part| part.as_bytes().is_empty())
            {
                expanded.pop_back();
            }
            expanded.append(&mut pending);
            pending = expanded;
            links.push(Link {
                parent,
                name,
                fd: child,
                target,
            });
            continue;
        }
        if final_component {
            break (parent, name, Some(child), trailing_slash);
        }
        if !kind.is_dir() {
            return Err(native_error(
                "ENOTDIR",
                "beneath component is not a directory",
            ));
        }
        if name.as_bytes() != b"." {
            stack.push(child.as_raw_fd());
            directories.push(Directory {
                parent,
                name,
                fd: child,
            });
        }
    };
    before_final();
    verify_walk(&directories, &links)?;
    if let Some(expected) = &expected {
        verify_entry(parent, &name, expected.as_raw_fd())?;
    }
    let opened = openat(
        borrowed(parent),
        &name,
        flags
            | OFlags::NOFOLLOW
            | OFlags::CLOEXEC
            | if require_directory {
                OFlags::DIRECTORY
            } else {
                OFlags::empty()
            },
        mode,
    )
    .map_err(|error| os_error(error, "openat beneath root fallback"))?;
    if let Some(expected) = expected {
        let before = rustix::fs::fstat(expected.as_fd())
            .map_err(|error| os_error(error, "inspect expected beneath entry"))?;
        let after = rustix::fs::fstat(opened.as_fd())
            .map_err(|error| os_error(error, "inspect opened beneath entry"))?;
        if !matches_identity(&before, &after) {
            return Err(changed());
        }
    }
    verify_entry(parent, &name, opened.as_raw_fd())?;
    verify_walk(&directories, &links)?;
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn fixture(label: &str) -> (std::path::PathBuf, fs::File) {
        let dir =
            std::env::temp_dir().join(format!("fs-safe-beneath-{label}-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("actual")).unwrap();
        fs::write(dir.join("actual/file"), "payload").unwrap();
        let root = fs::File::open(&dir).unwrap();
        (dir, root)
    }

    fn parity(root: i32, path: &str, flags: OFlags) -> Result<Stat, String> {
        let mode = if flags.contains(OFlags::CREATE) {
            Mode::RUSR | Mode::WUSR
        } else {
            Mode::empty()
        };
        let mut retries = 0;
        let kernel = loop {
            let result = openat2(
                borrowed(root),
                path,
                flags,
                mode,
                ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
            );
            match result {
                // Unrelated renames can make scoped kernel lookup of `..` retry.
                Err(rustix::io::Errno::AGAIN) => {
                    assert!(
                        retries < 7,
                        "{path}: kernel openat2 exhausted 8 attempts, raw errno={}",
                        rustix::io::Errno::AGAIN.raw_os_error(),
                    );
                    retries += 1;
                    std::thread::yield_now();
                }
                result => break result,
            }
        };
        let fallback = open_fallback(root, path, flags, mode);
        match (kernel, fallback) {
            (Ok(kernel), Ok(fallback)) => {
                let expected = rustix::fs::fstat(kernel).unwrap();
                let actual = rustix::fs::fstat(fallback).unwrap();
                assert!(matches_identity(&expected, &actual), "{path}");
                Ok(actual)
            }
            (Err(kernel), Err(fallback)) => {
                assert_eq!(
                    os_error(kernel, "kernel").status,
                    fallback.status,
                    "{path}: kernel={kernel:?}, raw errno={}, fallback={fallback:?}",
                    kernel.raw_os_error(),
                );
                Err(fallback.status)
            }
            (kernel, fallback) => panic!("{path}: kernel={kernel:?}, fallback={fallback:?}"),
        }
    }

    #[test]
    fn resolves_relative_links_and_preserves_final_flags() {
        let (dir, root) = fixture("links");
        symlink("actual", dir.join("alias")).unwrap();
        symlink("alias", dir.join("chain")).unwrap();
        symlink("../actual", dir.join("actual/up")).unwrap();
        symlink("actual/new", dir.join("dangling")).unwrap();
        symlink("actual/", dir.join("slash")).unwrap();
        symlink("actual/file/", dir.join("file-slash")).unwrap();
        for path in [
            "alias/file",
            "chain/file",
            "actual/up/file",
            "slash/file",
            "alias/../actual/file",
        ] {
            assert!(parity(root.as_raw_fd(), path, OFlags::RDONLY).is_ok());
        }
        assert!(
            parity(
                root.as_raw_fd(),
                "dangling",
                OFlags::CREATE | OFlags::WRONLY
            )
            .is_ok()
        );
        for flags in [
            OFlags::RDONLY,
            OFlags::PATH,
            OFlags::RDONLY | OFlags::DIRECTORY,
            OFlags::PATH | OFlags::DIRECTORY,
            OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY,
        ] {
            for path in [
                "alias",
                "alias/",
                "alias/.",
                "file-slash",
                "missing/",
                "missing/.",
                "missing/file/",
            ] {
                let _ = parity(root.as_raw_fd(), path, flags | OFlags::NOFOLLOW);
            }
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preserves_search_permissions_and_directory_suffixes() {
        use std::os::unix::fs::PermissionsExt;
        // Root's DAC override would make the no-search regression vacuous.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (dir, root) = fixture("permissions");
        symlink("actual/../actual/file", dir.join("up")).unwrap();
        symlink("actual/", dir.join("slash")).unwrap();
        fs::set_permissions(dir.join("actual"), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(parity(root.as_raw_fd(), "actual/", OFlags::PATH).is_ok());
        assert!(parity(root.as_raw_fd(), "slash/", OFlags::PATH).is_ok());
        assert_eq!(
            parity(root.as_raw_fd(), "actual/.", OFlags::PATH).unwrap_err(),
            "EACCES"
        );
        assert_eq!(
            parity(root.as_raw_fd(), "up", OFlags::PATH).unwrap_err(),
            "EACCES"
        );
        fs::set_permissions(dir.join("actual"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_sticky_shared_links_even_when_stat_owners_match() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, root) = fixture("sticky-equal");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o1777)).unwrap();
        symlink("actual/file", dir.join("alias")).unwrap();
        // Equal stat UIDs are not proof of equal kernel owners in a user
        // namespace: both could be the overflow UID. Refuse that case too.
        assert_eq!(
            open_fallback(root.as_raw_fd(), "alias", OFlags::RDONLY, Mode::empty())
                .unwrap_err()
                .status,
            "EACCES"
        );
        assert!(parity(root.as_raw_fd(), "alias", OFlags::PATH | OFlags::NOFOLLOW).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_foreign_owned_links_in_sticky_shared_directories() {
        use std::os::unix::fs::PermissionsExt;
        // Run this case as root in the isolated Linux proof to create the
        // foreign-owned symlink without changing the test process credentials.
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let (dir, root) = fixture("sticky");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o1777)).unwrap();
        symlink("actual/file", dir.join("foreign")).unwrap();
        let name = CString::new(dir.join("foreign").as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: name is a live NUL-terminated pathname; -1 retains the group.
        assert_eq!(unsafe { libc::lchown(name.as_ptr(), 65534, !0) }, 0);
        assert_eq!(
            open_fallback(root.as_raw_fd(), "foreign", OFlags::RDONLY, Mode::empty())
                .unwrap_err()
                .status,
            "EACCES"
        );
        if fs::read_to_string("/proc/sys/fs/protected_symlinks")
            .unwrap()
            .trim()
            == "1"
        {
            assert_eq!(
                parity(root.as_raw_fd(), "foreign", OFlags::RDONLY).unwrap_err(),
                "EACCES"
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exclusive_creation_leaves_contested_leaf_to_the_final_syscall() {
        let (dir, root) = fixture("exclusive");
        for disappears in [false, true] {
            fs::write(dir.join("contested"), "old").unwrap();
            let result = open_fallback_with_hook(
                root.as_raw_fd(),
                "contested",
                OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY,
                Mode::RUSR | Mode::WUSR,
                || {
                    fs::remove_file(dir.join("contested")).unwrap();
                    if !disappears {
                        fs::write(dir.join("contested"), "competitor").unwrap();
                    }
                },
            );
            if disappears {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err().status, "EEXIST");
                assert_eq!(fs::read(dir.join("contested")).unwrap(), b"competitor");
            }
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn respects_nosymfollow_mount() {
        let Some(mount) = std::env::var_os("FS_SAFE_TEST_NOSYMFOLLOW_ROOT") else {
            return;
        };
        let dir = std::path::PathBuf::from(mount)
            .join(format!("fs-safe-nosymfollow-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("file"), "payload").unwrap();
        symlink("file", dir.join("alias")).unwrap();
        let root = fs::File::open(&dir).unwrap();
        assert_eq!(
            parity(root.as_raw_fd(), "alias", OFlags::RDONLY).unwrap_err(),
            "ELOOP"
        );
        assert!(parity(root.as_raw_fd(), "alias", OFlags::PATH | OFlags::NOFOLLOW).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_escapes_and_limits_link_expansion() {
        let (dir, root) = fixture("escapes");
        symlink("../../outside", dir.join("actual/escape")).unwrap();
        symlink(dir.join("actual"), dir.join("absolute")).unwrap();
        symlink("loop", dir.join("loop")).unwrap();
        for (path, error) in [
            ("actual/escape", "EXDEV"),
            ("absolute/file", "EXDEV"),
            ("loop", "ELOOP"),
        ] {
            assert_eq!(
                parity(root.as_raw_fd(), path, OFlags::RDONLY).unwrap_err(),
                error
            );
        }
        for index in 0..41 {
            symlink(
                if index == 40 {
                    "actual/file".to_string()
                } else {
                    format!("link{}", index + 1)
                },
                dir.join(format!("link{index}")),
            )
            .unwrap();
        }
        assert!(parity(root.as_raw_fd(), "link1", OFlags::RDONLY).is_ok());
        assert_eq!(
            parity(root.as_raw_fd(), "link0", OFlags::RDONLY).unwrap_err(),
            "ELOOP"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detects_retargeted_links_and_popped_directories() {
        let (dir, root) = fixture("races");
        for replace_directory in [false, true] {
            symlink("actual/../actual", dir.join("alias")).unwrap();
            let error = open_fallback_with_hook(
                root.as_raw_fd(),
                "alias/new",
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
                Mode::RUSR | Mode::WUSR,
                || {
                    if replace_directory {
                        fs::rename(dir.join("actual"), dir.join("moved")).unwrap();
                        fs::create_dir(dir.join("actual")).unwrap();
                    } else {
                        fs::remove_file(dir.join("alias")).unwrap();
                        symlink("actual", dir.join("alias")).unwrap();
                    }
                },
            )
            .unwrap_err();
            assert_eq!(error.status, "EXDEV");
            assert!(!dir.join("actual/new").exists());
            assert!(!dir.join("moved/new").exists());
            fs::remove_file(dir.join("alias")).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn never_follows_procfs_magic_links() {
        let proc = fs::File::open("/proc").unwrap();
        let path = format!("{}/fd/{}", std::process::id(), proc.as_raw_fd());
        assert_eq!(
            parity(proc.as_raw_fd(), &path, OFlags::PATH).unwrap_err(),
            "ELOOP"
        );
        assert!(parity(proc.as_raw_fd(), &path, OFlags::PATH | OFlags::NOFOLLOW).is_ok());
    }

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
            assert_eq!(error.status, "EXDEV");
            assert!(!dir.join("outside/created").exists());
            fs::remove_dir_all(dir.join("root")).unwrap();
            fs::remove_dir_all(dir.join("outside")).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
