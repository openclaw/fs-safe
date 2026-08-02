#[cfg(target_os = "macos")]
use std::ffi::CString;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd};

use rustix::fs::{AtFlags, FileType, Mode, OFlags, RenameFlags};

use crate::{FileIdentity, NativeResult, native_error};

fn borrowed(fd: i32) -> BorrowedFd<'static> {
    // SAFETY: Every public operation borrows the descriptor only for the
    // duration of the call. Ownership stays with Node.js.
    unsafe { BorrowedFd::borrow_raw(fd) }
}

fn os_error(error: rustix::io::Errno, operation: &str) -> napi::Error<String> {
    let code = match error {
        rustix::io::Errno::EXIST => "EEXIST",
        rustix::io::Errno::NOENT => "ENOENT",
        rustix::io::Errno::LOOP => "ELOOP",
        rustix::io::Errno::NOTDIR => "ENOTDIR",
        rustix::io::Errno::ACCESS => "EACCES",
        rustix::io::Errno::PERM => "EPERM",
        rustix::io::Errno::XDEV => "EXDEV",
        rustix::io::Errno::NOTEMPTY => "ENOTEMPTY",
        _ => "EIO",
    };
    native_error(code, format!("{operation}: {error}"))
}

fn validate_beneath_path(path: &str) -> NativeResult<()> {
    if path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
        return Err(native_error(
            "EINVAL",
            "relative path must remain beneath root",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn open_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<i32> {
    use rustix::fs::{ResolveFlags, openat2};

    validate_beneath_path(rel_path)?;
    if rel_path.is_empty() || rel_path == "." {
        return rustix::io::dup(borrowed(root_fd))
            .map(OwnedFd::into_raw_fd)
            .map_err(|error| os_error(error, "duplicate root descriptor"));
    }
    let path = if rel_path.is_empty() { "." } else { rel_path };
    let mut oflags = OFlags::from_bits_retain(flags as u32);
    let require_directory = oflags.contains(OFlags::DIRECTORY);
    oflags.remove(OFlags::DIRECTORY);
    let mode = if oflags.intersects(OFlags::CREATE | OFlags::TMPFILE) {
        Mode::from_bits_retain(0o600)
    } else {
        Mode::empty()
    };
    let fd = openat2(
        borrowed(root_fd),
        path,
        oflags,
        mode,
        ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|error| os_error(error, "openat2 beneath root"))?;
    if require_directory {
        let stat = rustix::fs::fstat(fd.as_fd())
            .map_err(|error| os_error(error, "fstat opened directory"))?;
        if !FileType::from_raw_mode(stat.st_mode).is_dir() {
            return Err(native_error("ENOTDIR", "opened path is not a directory"));
        }
    }
    Ok(fd.into_raw_fd())
}

#[cfg(target_os = "macos")]
pub fn open_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<i32> {
    validate_beneath_path(rel_path)?;
    macos::open_beneath(root_fd, rel_path, flags)
}

fn split_parent(path: &str) -> NativeResult<(&str, &str)> {
    match path.rsplit_once('/') {
        Some((parent, basename)) if !basename.is_empty() => Ok((parent, basename)),
        None if !path.is_empty() => Ok(("", path)),
        _ => Err(native_error("EINVAL", "operation requires a basename")),
    }
}

fn directory_open_flags() -> i32 {
    (OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC).bits() as i32
}

fn open_parent(root_fd: i32, path: &str) -> NativeResult<(OwnedFd, &str)> {
    let (parent, basename) = split_parent(path)?;
    let fd = open_beneath(root_fd, parent, directory_open_flags())?;
    // SAFETY: open_beneath returns a newly owned descriptor.
    Ok((unsafe { OwnedFd::from_raw_fd(fd) }, basename))
}

pub fn mkdir_beneath(root_fd: i32, rel_path: &str, mode: u32) -> NativeResult<()> {
    if rel_path.is_empty() || rel_path == "." {
        return Ok(());
    }
    let mut current = rustix::io::dup(borrowed(root_fd))
        .map_err(|error| os_error(error, "duplicate root descriptor"))?;
    for segment in rel_path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
    {
        match rustix::fs::mkdirat(current.as_fd(), segment, Mode::from_bits_retain(mode as _)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(os_error(error, "mkdirat beneath root")),
        }
        let next = open_beneath(current.as_fd().as_raw_fd(), segment, directory_open_flags())?;
        // SAFETY: open_beneath returns a newly owned descriptor.
        current = unsafe { OwnedFd::from_raw_fd(next) };
    }
    Ok(())
}

pub fn link_beneath(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let (source_parent, source_name) = open_parent(source_root_fd, source_rel_path)?;
    let (target_parent, target_name) = open_parent(target_root_fd, target_rel_path)?;
    rustix::fs::linkat(
        source_parent.as_fd(),
        source_name,
        target_parent.as_fd(),
        target_name,
        AtFlags::empty(),
    )
    .map_err(|error| os_error(error, "linkat beneath roots"))
}

pub fn rename_no_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let (source_parent, source_name) = open_parent(source_root_fd, source_rel_path)?;
    let (target_parent, target_name) = open_parent(target_root_fd, target_rel_path)?;
    let result = rustix::fs::renameat_with(
        source_parent.as_fd(),
        source_name,
        target_parent.as_fd(),
        target_name,
        RenameFlags::NOREPLACE,
    );
    match result {
        Ok(()) => Ok(()),
        Err(_error)
            if rustix::fs::statat(
                target_parent.as_fd(),
                target_name,
                AtFlags::SYMLINK_NOFOLLOW,
            )
            .is_ok() =>
        {
            Err(native_error("EEXIST", "rename destination already exists"))
        }
        Err(error) => Err(os_error(error, "rename without replacement")),
    }
}

pub fn rename_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let (source_parent, source_name) = open_parent(source_root_fd, source_rel_path)?;
    let (target_parent, target_name) = open_parent(target_root_fd, target_rel_path)?;
    rustix::fs::renameat(
        source_parent.as_fd(),
        source_name,
        target_parent.as_fd(),
        target_name,
    )
    .map_err(|error| os_error(error, "rename with replacement"))
}

pub fn fstat_identity(fd: i32) -> NativeResult<FileIdentity> {
    let stat = rustix::fs::fstat(borrowed(fd)).map_err(|error| os_error(error, "fstat"))?;
    let file_type = FileType::from_raw_mode(stat.st_mode);
    Ok(FileIdentity {
        dev: stat.st_dev as f64,
        ino: stat.st_ino as f64,
        mode: stat.st_mode as u32,
        nlink: stat.st_nlink as f64,
        size: stat.st_size as f64,
        is_file: file_type.is_file(),
        is_directory: file_type.is_dir(),
        is_symbolic_link: file_type.is_symlink(),
    })
}

pub fn write_archive_file<R: Read>(
    root_fd: i32,
    rel_path: &str,
    reader: &mut R,
    expected_size: u64,
    mode: u32,
) -> NativeResult<()> {
    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC;
    let fd = open_beneath(root_fd, rel_path, flags.bits() as i32)?;
    // SAFETY: open_beneath returned a fresh descriptor owned by this call.
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut file = std::fs::File::from(owned);
    let copied = std::io::copy(&mut reader.take(expected_size.saturating_add(1)), &mut file)
        .map_err(|error| native_error("EIO", format!("write archive entry: {error}")))?;
    if copied != expected_size {
        return Err(native_error(
            "EINVAL",
            "archive entry size did not match its manifest",
        ));
    }
    file.flush()
        .map_err(|error| native_error("EIO", format!("flush archive entry: {error}")))?;
    rustix::fs::fchmod(file.as_fd(), Mode::from_bits_retain(mode as _))
        .map_err(|error| os_error(error, "set archive entry mode"))
}

pub fn chmod_beneath(root_fd: i32, rel_path: &str, mode: u32) -> NativeResult<()> {
    let fd = open_beneath(
        root_fd,
        rel_path,
        (OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
    )?;
    // SAFETY: open_beneath returned a fresh descriptor owned by this call.
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    rustix::fs::fchmod(owned.as_fd(), Mode::from_bits_retain(mode as _))
        .map_err(|error| os_error(error, "set archive directory mode"))
}

pub type IndependentReader = i32;

pub fn open_independent_reader(fd: i32) -> NativeResult<IndependentReader> {
    Ok(fd)
}

pub fn read_at(reader: &IndependentReader, buffer: &mut [u8], offset: u64) -> NativeResult<usize> {
    rustix::io::pread(borrowed(*reader), buffer, offset)
        .map_err(|error| os_error(error, "read file at offset"))
}

#[cfg(target_os = "linux")]
fn create_exclusive_target(root_fd: i32, rel_path: &str) -> NativeResult<OwnedFd> {
    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC;
    let fd = open_beneath(root_fd, rel_path, flags.bits() as i32)?;
    // SAFETY: open_beneath returned a fresh descriptor owned by this call.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn remove_created_target(root_fd: i32, rel_path: &str, target: &OwnedFd) {
    #[cfg(target_os = "macos")]
    // SAFETY: target is an open descriptor owned by the caller.
    unsafe {
        libc::fchflags(target.as_raw_fd(), 0);
    }
    let Ok(target_stat) = rustix::fs::fstat(target.as_fd()) else {
        return;
    };
    let Ok((parent, name)) = open_parent(root_fd, rel_path) else {
        return;
    };
    let Ok(path_stat) = rustix::fs::statat(parent.as_fd(), name, AtFlags::SYMLINK_NOFOLLOW) else {
        return;
    };
    if target_stat.st_dev == path_stat.st_dev && target_stat.st_ino == path_stat.st_ino {
        let _ = rustix::fs::unlinkat(parent.as_fd(), name, AtFlags::empty());
    }
}

#[cfg(target_os = "linux")]
pub fn clone_file_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<i32> {
    let target = create_exclusive_target(target_root_fd, target_rel_path)?;
    if let Err(error) = rustix::fs::ioctl_ficlone(target.as_fd(), borrowed(source_fd)) {
        remove_created_target(target_root_fd, target_rel_path, &target);
        return Err(native_error(
            "ENOTSUP",
            format!("FICLONE is unavailable: {error}"),
        ));
    }
    if let Err(error) = rustix::fs::fchmod(target.as_fd(), Mode::from_bits_retain(0o600))
        .and_then(|()| rustix::fs::fsync(target.as_fd()))
    {
        remove_created_target(target_root_fd, target_rel_path, &target);
        return Err(os_error(error, "normalize cloned file"));
    }
    Ok(target.into_raw_fd())
}

#[cfg(target_os = "macos")]
pub fn clone_file_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<i32> {
    use std::sync::atomic::{AtomicU64, Ordering};

    const CLONE_NOOWNERCOPY: u32 = 0x0002;
    static CLONE_COUNTER: AtomicU64 = AtomicU64::new(0);
    let parent_stat = rustix::fs::fstat(borrowed(target_root_fd))
        .map_err(|error| os_error(error, "inspect clone target parent"))?;
    // SAFETY: geteuid has no preconditions.
    let effective_uid = unsafe { libc::geteuid() };
    if parent_stat.st_uid != effective_uid
        || parent_stat.st_mode & 0o022 != 0
        || macos_acl_has_entries(target_root_fd)?
    {
        return Err(native_error(
            "ENOTSUP",
            "cloning requires an owned target parent without broad modes or ACLs",
        ));
    }
    let source_stat = rustix::fs::fstat(borrowed(source_fd))
        .map_err(|error| os_error(error, "inspect clone source"))?;
    if source_stat.st_flags != 0 {
        return Err(native_error(
            "ENOTSUP",
            "cloning is disabled for sources with file flags",
        ));
    }
    let stage_path = (0..8)
        .find_map(|_| {
            let nonce = CLONE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = format!(".fs-safe-clone-stage-{}-{nonce}", std::process::id());
            match rustix::fs::mkdirat(
                borrowed(target_root_fd),
                candidate.as_str(),
                Mode::from_bits_retain(0o700),
            ) {
                Ok(()) => Some(candidate),
                Err(rustix::io::Errno::EXIST) => None,
                Err(_) => None,
            }
        })
        .ok_or_else(|| native_error("EIO", "create private clone staging directory"))?;
    let stage_fd = match open_beneath(
        target_root_fd,
        &stage_path,
        (OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
    ) {
        Ok(fd) => {
            // SAFETY: open_beneath returned a fresh descriptor owned here.
            unsafe { OwnedFd::from_raw_fd(fd) }
        }
        Err(error) => {
            let _ = rustix::fs::unlinkat(
                borrowed(target_root_fd),
                stage_path.as_str(),
                AtFlags::REMOVEDIR,
            );
            return Err(error);
        }
    };

    let payload = CString::new("payload").unwrap();
    // SAFETY: descriptors are borrowed for this call and payload is NUL-terminated.
    if unsafe {
        libc::fclonefileat(
            source_fd,
            stage_fd.as_raw_fd(),
            payload.as_ptr(),
            CLONE_NOOWNERCOPY,
        )
    } != 0
    {
        let error = std::io::Error::last_os_error();
        let _ = rustix::fs::unlinkat(
            borrowed(target_root_fd),
            stage_path.as_str(),
            AtFlags::REMOVEDIR,
        );
        let code = match error.raw_os_error() {
            Some(libc::EXDEV) | Some(libc::ENOTSUP) | Some(libc::EINVAL) => "ENOTSUP",
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            _ => "EIO",
        };
        return Err(native_error(code, format!("fclonefileat: {error}")));
    }
    let target_fd = match open_beneath(
        stage_fd.as_raw_fd(),
        "payload",
        (OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
    ) {
        Ok(fd) => fd,
        Err(error) => {
            let _ = rustix::fs::unlinkat(stage_fd.as_fd(), "payload", AtFlags::empty());
            let _ = rustix::fs::unlinkat(
                borrowed(target_root_fd),
                stage_path.as_str(),
                AtFlags::REMOVEDIR,
            );
            return Err(error);
        }
    };
    // SAFETY: open_beneath returned a fresh descriptor owned here.
    let target = unsafe { OwnedFd::from_raw_fd(target_fd) };

    let normalize = || -> NativeResult<()> {
        // SAFETY: target is an open descriptor owned by this call.
        if unsafe { libc::fchflags(target.as_raw_fd(), 0) } != 0 {
            return Err(native_error(
                "EIO",
                format!(
                    "clear cloned file flags: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        clear_macos_acl(target.as_raw_fd())?;
        rustix::fs::fchmod(target.as_fd(), Mode::from_bits_retain(0o600))
            .map_err(|error| os_error(error, "set cloned file mode"))?;
        clear_macos_xattrs(target.as_raw_fd())?;
        rustix::fs::fsync(target.as_fd()).map_err(|error| os_error(error, "sync cloned file"))
    };
    if let Err(error) = normalize() {
        remove_created_target(stage_fd.as_raw_fd(), "payload", &target);
        let _ = rustix::fs::unlinkat(
            borrowed(target_root_fd),
            stage_path.as_str(),
            AtFlags::REMOVEDIR,
        );
        return Err(error);
    }
    if let Err(error) = rename_no_replace(
        stage_fd.as_raw_fd(),
        "payload",
        target_root_fd,
        target_rel_path,
    ) {
        remove_created_target(stage_fd.as_raw_fd(), "payload", &target);
        let _ = rustix::fs::unlinkat(
            borrowed(target_root_fd),
            stage_path.as_str(),
            AtFlags::REMOVEDIR,
        );
        return Err(error);
    }
    let _ = rustix::fs::unlinkat(
        borrowed(target_root_fd),
        stage_path.as_str(),
        AtFlags::REMOVEDIR,
    );
    Ok(target.into_raw_fd())
}

#[cfg(target_os = "macos")]
fn clear_macos_acl(fd: i32) -> NativeResult<()> {
    const ACL_TYPE_EXTENDED: i32 = 0x0000_0100;
    unsafe extern "C" {
        fn acl_init(count: i32) -> *mut c_void;
        fn acl_set_fd_np(fd: i32, acl: *mut c_void, acl_type: i32) -> i32;
        fn acl_free(object: *mut c_void) -> i32;
    }

    // SAFETY: acl_init allocates an empty ACL owned by this function.
    let acl = unsafe { acl_init(0) };
    if acl.is_null() {
        return Err(native_error(
            "EIO",
            format!("allocate empty ACL: {}", std::io::Error::last_os_error()),
        ));
    }
    // SAFETY: fd and acl are valid for the duration of the call.
    let result = unsafe { acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED) };
    // SAFETY: acl was allocated by acl_init and is freed exactly once.
    unsafe { acl_free(acl) };
    if result != 0 {
        return Err(native_error(
            "EIO",
            format!("clear cloned file ACL: {}", std::io::Error::last_os_error()),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_acl_has_entries(fd: i32) -> NativeResult<bool> {
    const ACL_TYPE_EXTENDED: i32 = 0x0000_0100;
    const ACL_FIRST_ENTRY: i32 = 0;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: i32, acl_type: i32) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
        fn acl_free(object: *mut c_void) -> i32;
    }

    // SAFETY: acl_get_fd_np borrows fd and returns an owned ACL object.
    let acl = unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        let code = error.raw_os_error();
        return if matches!(code, Some(libc::ENOENT) | Some(libc::ENOATTR)) {
            Ok(false)
        } else if code == Some(libc::ENOTSUP)
            || code == Some(libc::EOPNOTSUPP)
            || code == Some(libc::EINVAL)
        {
            Err(native_error(
                "ENOTSUP",
                format!("inspect parent ACL: {error}"),
            ))
        } else {
            Err(native_error("EIO", format!("inspect parent ACL: {error}")))
        };
    }
    let mut entry = std::ptr::null_mut();
    // SAFETY: acl is valid and entry is writable for one pointer.
    let result = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) };
    // SAFETY: acl was returned by acl_get_fd_np and is freed exactly once.
    unsafe { acl_free(acl) };
    match result {
        1 => Ok(true),
        0 => Ok(false),
        _ => Err(native_error(
            "EIO",
            format!("enumerate parent ACL: {}", std::io::Error::last_os_error()),
        )),
    }
}

#[cfg(target_os = "macos")]
fn clear_macos_xattrs(fd: i32) -> NativeResult<()> {
    // SAFETY: null buffer queries the required list size.
    let length = unsafe { libc::flistxattr(fd, std::ptr::null_mut(), 0, 0) };
    if length < 0 {
        return Err(native_error(
            "EIO",
            format!(
                "list cloned file xattrs: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    if length == 0 {
        return Ok(());
    }
    let mut names = vec![0_u8; length as usize];
    // SAFETY: names is writable for its full allocation.
    let read = unsafe { libc::flistxattr(fd, names.as_mut_ptr().cast(), names.len(), 0) };
    if read < 0 {
        return Err(native_error(
            "EIO",
            format!(
                "read cloned file xattrs: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    names.truncate(read as usize);
    for name in names
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let name = CString::new(name)
            .map_err(|_| native_error("EINVAL", "cloned xattr name contains a NUL byte"))?;
        // SAFETY: name is NUL-terminated and fd remains open.
        if unsafe { libc::fremovexattr(fd, name.as_ptr(), 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOATTR)
        {
            return Err(native_error(
                "EIO",
                format!(
                    "remove cloned file xattr: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn copy_file_range_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<(i32, u64)> {
    let target = create_exclusive_target(target_root_fd, target_rel_path)?;
    let source_stat = rustix::fs::fstat(borrowed(source_fd))
        .map_err(|error| os_error(error, "inspect copy source"))?;
    let expected = u64::try_from(source_stat.st_size)
        .map_err(|_| native_error("EINVAL", "copy source has a negative size"))?;
    let mut source_offset = 0_u64;
    let mut target_offset = 0_u64;
    while source_offset < expected {
        let length = usize::try_from((expected - source_offset).min(16 * 1024 * 1024)).unwrap();
        match rustix::fs::copy_file_range(
            borrowed(source_fd),
            Some(&mut source_offset),
            target.as_fd(),
            Some(&mut target_offset),
            length,
        ) {
            Ok(0) => {
                remove_created_target(target_root_fd, target_rel_path, &target);
                return Err(native_error("EIO", "copy_file_range made no progress"));
            }
            Ok(_) => {}
            Err(error) => {
                remove_created_target(target_root_fd, target_rel_path, &target);
                return Err(native_error(
                    "ENOTSUP",
                    format!("copy_file_range is unavailable: {error}"),
                ));
            }
        }
    }
    if let Err(error) = rustix::fs::fchmod(target.as_fd(), Mode::from_bits_retain(0o600))
        .and_then(|()| rustix::fs::fsync(target.as_fd()))
    {
        remove_created_target(target_root_fd, target_rel_path, &target);
        return Err(os_error(error, "normalize copied file"));
    }
    Ok((target.into_raw_fd(), target_offset))
}

#[cfg(target_os = "macos")]
pub fn copy_file_range_exclusive(
    _source_fd: i32,
    _target_root_fd: i32,
    _target_rel_path: &str,
) -> NativeResult<(i32, u64)> {
    Err(native_error(
        "ENOTSUP",
        "copy_file_range is only available on Linux",
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::VecDeque;
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
    use std::sync::OnceLock;

    use crate::{NativeResult, native_error};

    const MAX_SYMLINKS: usize = 40;
    const O_RESOLVE_BENEATH: i32 = 0x0000_1000;
    static RESOLVE_BENEATH_AVAILABLE: OnceLock<bool> = OnceLock::new();

    fn last_error(operation: &str) -> napi::Error<String> {
        let error = std::io::Error::last_os_error();
        let code = match error.raw_os_error() {
            Some(libc::EEXIST) => "EEXIST",
            Some(libc::ENOENT) => "ENOENT",
            Some(libc::ELOOP) => "ELOOP",
            Some(libc::ENOTDIR) => "ENOTDIR",
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            _ => "EIO",
        };
        native_error(code, format!("{operation}: {error}"))
    }

    fn duplicate(fd: RawFd) -> NativeResult<OwnedFd> {
        // SAFETY: dup does not borrow beyond this call and returns a fresh fd.
        let duplicated = unsafe { libc::dup(fd) };
        if duplicated < 0 {
            return Err(last_error("duplicate root descriptor"));
        }
        // SAFETY: duplicated is a new owned descriptor.
        Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
    }

    fn root_path(fd: RawFd) -> NativeResult<String> {
        let mut buffer = vec![0_i8; libc::PATH_MAX as usize];
        // SAFETY: buffer is writable for PATH_MAX bytes.
        if unsafe { libc::fcntl(fd, libc::F_GETPATH, buffer.as_mut_ptr()) } < 0 {
            return Err(last_error("resolve root descriptor path"));
        }
        // SAFETY: F_GETPATH writes a NUL-terminated string on success.
        Ok(unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }

    pub(super) fn resolve_beneath_available() -> bool {
        *RESOLVE_BENEATH_AVAILABLE.get_or_init(probe_resolve_beneath_availability)
    }

    fn probe_resolve_beneath_availability() -> bool {
        let mut info = std::mem::MaybeUninit::<libc::utsname>::zeroed();
        // SAFETY: uname initializes the supplied utsname on success.
        if unsafe { libc::uname(info.as_mut_ptr()) } != 0 {
            return false;
        }
        // SAFETY: uname succeeded, so info is initialized and release is NUL-terminated.
        let info = unsafe { info.assume_init() };
        let release = unsafe { CStr::from_ptr(info.release.as_ptr()) }.to_string_lossy();
        let mut parts = release
            .split('.')
            .filter_map(|part| part.parse::<u32>().ok());
        let major = parts.next().unwrap_or(0);
        let minor = parts.next().unwrap_or(0);
        major > 24 || (major == 24 && minor >= 4)
    }

    fn verify_opened_beneath(root_fd: RawFd, opened: OwnedFd) -> NativeResult<i32> {
        let root = root_path(root_fd)?;
        let opened_path = root_path(opened.as_raw_fd())?;
        if !std::path::Path::new(&opened_path).starts_with(std::path::Path::new(&root)) {
            return Err(native_error(
                "EXDEV",
                format!("opened path escaped root: {opened_path}"),
            ));
        }
        Ok(opened.into_raw_fd())
    }

    fn open_with_resolve_beneath(root_fd: RawFd, rel_path: &str, flags: i32) -> NativeResult<i32> {
        let path = CString::new(rel_path.as_bytes())
            .map_err(|_| native_error("EINVAL", "path contains a NUL byte"))?;
        // SAFETY: root_fd is borrowed for this call and path is NUL-terminated.
        let opened = unsafe {
            libc::openat(
                root_fd,
                path.as_ptr(),
                flags | libc::O_CLOEXEC | O_RESOLVE_BENEATH,
                0o600,
            )
        };
        if opened < 0 {
            return Err(last_error("open path with O_RESOLVE_BENEATH"));
        }
        // SAFETY: openat returned a new descriptor owned by this call.
        verify_opened_beneath(root_fd, unsafe { OwnedFd::from_raw_fd(opened) })
    }

    fn read_link(fd: RawFd, name: &CString) -> NativeResult<String> {
        let mut buffer = vec![0_u8; libc::PATH_MAX as usize];
        // SAFETY: pointers are valid for this call and the buffer is writable.
        let read = unsafe {
            libc::readlinkat(fd, name.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len())
        };
        if read < 0 {
            return Err(last_error("read symlink beneath root"));
        }
        buffer.truncate(read as usize);
        String::from_utf8(buffer)
            .map_err(|_| native_error("EINVAL", "symlink target is not valid UTF-8"))
    }

    fn normalize(mut base: Vec<String>, target: &str) -> NativeResult<Vec<String>> {
        for segment in target.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    if base.pop().is_none() {
                        return Err(native_error("EXDEV", "symlink target escapes root"));
                    }
                }
                value => base.push(value.to_owned()),
            }
        }
        Ok(base)
    }

    fn absolute_target_segments(root_fd: RawFd, target: &str) -> NativeResult<Vec<String>> {
        let root = root_path(root_fd)?;
        let relative = target
            .strip_prefix(&root)
            .and_then(|value| {
                value
                    .strip_prefix('/')
                    .or(Some(value))
                    .filter(|_| target == root || target.as_bytes().get(root.len()) == Some(&b'/'))
            })
            .ok_or_else(|| native_error("EXDEV", "absolute symlink target escapes root"))?;
        normalize(Vec::new(), relative)
    }

    pub fn open_beneath(root_fd: RawFd, rel_path: &str, flags: i32) -> NativeResult<i32> {
        if rel_path.is_empty() || rel_path == "." {
            return verify_opened_beneath(root_fd, duplicate(root_fd)?);
        }
        if resolve_beneath_available() {
            return open_with_resolve_beneath(root_fd, rel_path, flags);
        }
        let mut queue: VecDeque<String> = rel_path
            .split('/')
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .map(ToOwned::to_owned)
            .collect();
        let mut current = duplicate(root_fd)?;
        let mut logical: Vec<String> = Vec::new();
        let mut followed = 0;

        while let Some(segment) = queue.pop_front() {
            let name = CString::new(segment.as_bytes())
                .map_err(|_| native_error("EINVAL", "path segment contains a NUL byte"))?;
            let is_final = queue.is_empty();
            let open_flags = if is_final {
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW
            } else {
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW
            };
            // SAFETY: current and name stay valid for the duration of openat.
            let opened =
                unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), open_flags, 0o600) };
            if opened >= 0 {
                if is_final {
                    // SAFETY: openat returned a new descriptor owned by this call.
                    return verify_opened_beneath(root_fd, unsafe { OwnedFd::from_raw_fd(opened) });
                }
                // SAFETY: opened is a new owned directory descriptor.
                current = unsafe { OwnedFd::from_raw_fd(opened) };
                logical.push(segment);
                continue;
            }
            let error = std::io::Error::last_os_error();
            let errno = error.raw_os_error();
            if !matches!(errno, Some(libc::ELOOP) | Some(libc::ENOTDIR))
                || (is_final && flags & libc::O_NOFOLLOW != 0)
            {
                return Err(last_error("open path beneath root"));
            }
            followed += 1;
            if followed > MAX_SYMLINKS {
                return Err(native_error("ELOOP", "too many symlinks beneath root"));
            }
            let target = match read_link(current.as_raw_fd(), &name) {
                Ok(target) => target,
                Err(_) => {
                    let code = if errno == Some(libc::ENOTDIR) {
                        "ENOTDIR"
                    } else {
                        "ELOOP"
                    };
                    return Err(native_error(
                        code,
                        format!("open path beneath root: {error}"),
                    ));
                }
            };
            let resolved = if target.starts_with('/') {
                absolute_target_segments(root_fd, &target)?
            } else {
                normalize(logical.clone(), &target)?
            };
            let remainder: Vec<String> = queue.drain(..).collect();
            queue = resolved.into_iter().chain(remainder).collect();
            current = duplicate(root_fd)?;
            logical.clear();
        }
        Err(native_error("EINVAL", "path did not resolve to an entry"))
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fs-safe-native-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn opens_and_creates_only_beneath_root() {
        let root = temp_root("open");
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/file"), b"ok").unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        let fd = open_beneath(
            root_handle.as_raw_fd(),
            "nested/file",
            OFlags::RDONLY.bits() as i32,
        )
        .unwrap();
        // SAFETY: fd is uniquely owned after open_beneath.
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        assert_eq!(fstat_identity(file.as_raw_fd()).unwrap().size, 2.0);
        assert!(
            open_beneath(
                root_handle.as_raw_fd(),
                "../outside",
                OFlags::RDONLY.bits() as i32,
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_no_replace_preserves_existing_target() {
        let root = temp_root("rename");
        fs::write(root.join("source"), b"source").unwrap();
        fs::write(root.join("target"), b"target").unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        let error = rename_no_replace(
            root_handle.as_raw_fd(),
            "source",
            root_handle.as_raw_fd(),
            "target",
        )
        .unwrap_err();
        assert_eq!(error.status, "EEXIST");
        assert_eq!(fs::read(root.join("target")).unwrap(), b"target");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_replace_replaces_existing_target() {
        let root = temp_root("rename-replace");
        fs::write(root.join("source"), b"source").unwrap();
        fs::write(root.join("target"), b"target").unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        rename_replace(
            root_handle.as_raw_fd(),
            "source",
            root_handle.as_raw_fd(),
            "target",
        )
        .unwrap();
        assert!(!root.join("source").exists());
        assert_eq!(fs::read(root.join("target")).unwrap(), b"source");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn follows_in_root_symlink_by_re_resolving_from_root() {
        use std::os::unix::fs::symlink;
        let root = temp_root("symlink");
        fs::create_dir(root.join("real")).unwrap();
        fs::write(root.join("real/file"), b"ok").unwrap();
        symlink("real", root.join("alias")).unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        let fd = open_beneath(
            root_handle.as_raw_fd(),
            "alias/file",
            OFlags::RDONLY.bits() as i32,
        )
        .unwrap();
        // SAFETY: fd is uniquely owned after open_beneath.
        drop(unsafe { std::fs::File::from_raw_fd(fd) });
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_beneath_flag_blocks_static_escape_and_allows_in_root_symlink() {
        use std::os::unix::fs::symlink;
        if !macos::resolve_beneath_available() {
            return;
        }

        let base = temp_root("resolve-beneath");
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::create_dir(root.join("real")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("real/file"), b"ok").unwrap();
        fs::write(outside.join("secret.txt"), b"outside").unwrap();
        symlink("..", root.join("sub/up")).unwrap();
        symlink("real", root.join("alias")).unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();

        assert!(
            macos::open_beneath(
                root_handle.as_raw_fd(),
                "sub/up/../outside/secret.txt",
                OFlags::RDONLY.bits() as i32,
            )
            .is_err()
        );
        let fd = macos::open_beneath(
            root_handle.as_raw_fd(),
            "alias/file",
            OFlags::RDONLY.bits() as i32,
        )
        .unwrap();
        // SAFETY: open_beneath returned a fresh descriptor owned by this test.
        drop(unsafe { std::fs::File::from_raw_fd(fd) });
        fs::remove_dir_all(base).unwrap();
    }
}
