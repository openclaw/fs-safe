use std::ffi::CStr;
#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd};

use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, RenameFlags};
use rustix::path::Arg;

use crate::{ExactFileIdentity, FileIdentity, NativeResult, native_error};

pub(crate) fn nonnegative_fd(fd: i32, operation: &str) -> NativeResult<i32> {
    // Reject sentinels; the caller still owns and retains each live descriptor.
    if fd < 0 {
        return Err(os_error(rustix::io::Errno::BADF, operation));
    }
    Ok(fd)
}

pub(crate) fn borrowed(fd: i32) -> BorrowedFd<'static> {
    // SAFETY: Every public operation borrows the descriptor only for the
    // duration of the call. Ownership stays with Node.js.
    unsafe { BorrowedFd::borrow_raw(fd) }
}

pub(crate) fn os_error(error: rustix::io::Errno, operation: &str) -> napi::Error<String> {
    // Collapsing a known namespace rejection into EIO makes callers preserve an
    // unpublished stage as though the rename might have committed.
    let code = match error {
        rustix::io::Errno::EXIST => "EEXIST",
        rustix::io::Errno::NOENT => "ENOENT",
        rustix::io::Errno::LOOP => "ELOOP",
        rustix::io::Errno::NOTDIR => "ENOTDIR",
        rustix::io::Errno::ACCESS => "EACCES",
        rustix::io::Errno::PERM => "EPERM",
        rustix::io::Errno::XDEV => "EXDEV",
        rustix::io::Errno::NOTEMPTY => "ENOTEMPTY",
        rustix::io::Errno::BADF => "EBADF",
        rustix::io::Errno::INTR => "EINTR",
        rustix::io::Errno::BUSY => "EBUSY",
        rustix::io::Errno::INVAL => "EINVAL",
        rustix::io::Errno::ISDIR => "EISDIR",
        rustix::io::Errno::MLINK => "EMLINK",
        rustix::io::Errno::NAMETOOLONG => "ENAMETOOLONG",
        rustix::io::Errno::NOSPC => "ENOSPC",
        rustix::io::Errno::NOSYS => "ENOSYS",
        rustix::io::Errno::ROFS => "EROFS",
        rustix::io::Errno::TXTBSY => "ETXTBSY",
        error if error == rustix::io::Errno::NOTSUP || error == rustix::io::Errno::OPNOTSUPP => {
            "ENOTSUP"
        }
        _ => "EIO",
    };
    native_error(code, format!("{operation}: {error}"))
}

pub fn close_owned_fd(fd: i32) -> NativeResult<()> {
    if fd < 0 {
        return Err(native_error("EBADF", "invalid native-owned file descriptor"));
    }
    // SAFETY: the caller transfers an addon-owned descriptor for one close.
    // An error also consumes ownership: retrying can close a reused descriptor.
    unsafe { rustix::io::try_close(fd) }
        .map_err(|error| os_error(error, "close native-owned file descriptor"))
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

fn duplicate_cloexec(fd: i32) -> NativeResult<OwnedFd> {
    // SAFETY: fcntl validates raw input and atomically marks its new fd CLOEXEC.
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        let error = std::io::Error::last_os_error();
        return Err(os_error(
            rustix::io::Errno::from_raw_os_error(error.raw_os_error().unwrap_or(libc::EIO)),
            "duplicate root descriptor",
        ));
    }
    // SAFETY: F_DUPFD_CLOEXEC returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

#[cfg(target_os = "linux")]
pub(crate) fn open_owned_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<OwnedFd> {
    use rustix::fs::{ResolveFlags, openat2};

    validate_beneath_path(rel_path)?;
    if rel_path.is_empty() || rel_path == "." {
        return duplicate_cloexec(root_fd);
    }
    // Negative sentinels are not retained capabilities: -1 cannot be borrowed,
    // and AT_FDCWD would substitute the process's working directory.
    if root_fd < 0 {
        return Err(os_error(rustix::io::Errno::BADF, "openat2 beneath root"));
    }
    let oflags = OFlags::from_bits_retain(flags as u32) | OFlags::CLOEXEC;
    // O_TMPFILE contains O_DIRECTORY; a directory-only open still requires mode 0.
    let mode = if oflags.contains(OFlags::CREATE) || oflags.contains(OFlags::TMPFILE) {
        Mode::from_bits_retain(0o600)
    } else {
        Mode::empty()
    };
    openat2(
        borrowed(root_fd),
        rel_path,
        oflags,
        mode,
        ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|error| os_error(error, "openat2 beneath root"))
}

#[cfg(target_os = "macos")]
pub(crate) fn open_owned_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<OwnedFd> {
    validate_beneath_path(rel_path)?;
    macos::open_beneath(root_fd, rel_path, flags)
}

pub fn open_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<i32> {
    open_owned_beneath(root_fd, rel_path, flags).map(OwnedFd::into_raw_fd)
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
    let directory = open_owned_beneath(root_fd, parent, directory_open_flags())?;
    Ok((directory, basename))
}

pub fn mkdir_child_beneath(parent_fd: i32, basename: &str, mode: u32) -> NativeResult<bool> {
    crate::validate_child_basename(basename)?;
    let parent_fd = nonnegative_fd(parent_fd, "mkdirat direct child")?;
    match rustix::fs::mkdirat(
        borrowed(parent_fd),
        basename,
        Mode::from_bits_retain(mode as _),
    ) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::EXIST) => Ok(false),
        Err(error) => Err(os_error(error, "mkdirat direct child")),
    }
}

pub fn mkdir_beneath(root_fd: i32, rel_path: &str, mode: u32) -> NativeResult<()> {
    if rel_path.is_empty() || rel_path == "." {
        return Ok(());
    }
    let mut current = duplicate_cloexec(root_fd)?;
    for segment in rel_path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
    {
        match rustix::fs::mkdirat(current.as_fd(), segment, Mode::from_bits_retain(mode as _)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(os_error(error, "mkdirat beneath root")),
        }
        current = open_owned_beneath(current.as_raw_fd(), segment, directory_open_flags())?;
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

fn direct_rename_no_replace(
    source_root_fd: i32,
    source_name: &str,
    target_root_fd: i32,
    target_name: &str,
) -> NativeResult<()> {
    // Reject signed descriptor sentinels in deterministic argument order
    // before any BorrowedFd can be constructed. The raw syscall also handles
    // stale, closed positive descriptors without assuming Rust fd validity.
    if source_root_fd < 0 {
        return Err(native_error("EBADF", "invalid source root descriptor"));
    }
    if target_root_fd < 0 {
        return Err(native_error("EBADF", "invalid target root descriptor"));
    }
    crate::validate_child_basename(source_name)?;
    crate::validate_child_basename(target_name)?;
    let result = source_name.into_with_c_str(|source_name| {
        target_name.into_with_c_str(|target_name| {
            #[cfg(target_os = "linux")]
            // SAFETY: both names are live NUL-terminated buffers. renameat2
            // accepts raw integers and reports invalid or closed descriptors.
            let status = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    source_root_fd,
                    source_name.as_ptr(),
                    target_root_fd,
                    target_name.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            #[cfg(target_os = "macos")]
            // SAFETY: both names are live NUL-terminated buffers. renameatx_np
            // accepts raw integers and reports invalid or closed descriptors.
            let status = unsafe {
                libc::renameatx_np(
                    source_root_fd,
                    source_name.as_ptr(),
                    target_root_fd,
                    target_name.as_ptr(),
                    libc::RENAME_EXCL,
                )
            };
            if status == 0 {
                Ok(())
            } else {
                let error = std::io::Error::last_os_error();
                Err(rustix::io::Errno::from_raw_os_error(
                    error.raw_os_error().unwrap_or(libc::EIO),
                ))
            }
        })
    });
    match result {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOTEMPTY) => {
            Err(native_error("EEXIST", "rename destination already exists"))
        }
        Err(error) => Err(os_error(error, "rename without replacement")),
    }
}

pub fn rename_no_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    if !source_rel_path.contains('/') && !target_rel_path.contains('/') {
        // lib.rs validated both names before dispatch. Direct children can use
        // the already-retained parent descriptors without a duplicate/reopen
        // (and, on macOS, without another F_GETPATH containment query).
        return direct_rename_no_replace(
            source_root_fd,
            source_rel_path,
            target_root_fd,
            target_rel_path,
        );
    }
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
        // A target observed after an arbitrary I/O error does not prove a
        // collision: a remote filesystem may have committed the rename.
        Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOTEMPTY) => {
            Err(native_error("EEXIST", "rename destination already exists"))
        }
        Err(error) => Err(os_error(error, "rename without replacement")),
    }
}

pub fn rename_no_replace_with_identity(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
    expected_source_identity: ExactFileIdentity,
) -> NativeResult<()> {
    // POSIX can dispatch atomically through the retained parents without
    // opening another source receipt; the caller's pre-dispatch fence remains.
    let _ = (expected_source_identity.dev, expected_source_identity.ino);
    rename_no_replace(
        source_root_fd,
        source_rel_path,
        target_root_fd,
        target_rel_path,
    )
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
    let fd = nonnegative_fd(fd, "fstat")?;
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
    let mut file = std::fs::File::from(open_owned_beneath(root_fd, rel_path, flags.bits() as i32)?);
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
    let owned = open_owned_beneath(
        root_fd,
        rel_path,
        (OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
    )?;
    rustix::fs::fchmod(owned.as_fd(), Mode::from_bits_retain(mode as _))
        .map_err(|error| os_error(error, "set archive directory mode"))
}

pub type IndependentReader = i32;

pub fn open_independent_reader(fd: i32) -> NativeResult<IndependentReader> {
    Ok(fd)
}

pub fn read_at(reader: &IndependentReader, buffer: &mut [u8], offset: u64) -> NativeResult<usize> {
    let fd = nonnegative_fd(*reader, "read file at offset")?;
    rustix::io::pread(borrowed(fd), buffer, offset)
        .map_err(|error| os_error(error, "read file at offset"))
}

#[cfg(target_os = "linux")]
pub(crate) fn create_exclusive_target(root_fd: i32, rel_path: &str) -> NativeResult<OwnedFd> {
    let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC;
    open_owned_beneath(root_fd, rel_path, flags.bits() as i32)
}

pub(crate) fn validate_child_basename(name: &str) -> NativeResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(native_error(
            "EINVAL",
            "staging requires one direct-child basename",
        ));
    }
    Ok(())
}

pub(crate) fn file_matches_child(parent_fd: i32, name: &str, file_fd: i32) -> NativeResult<bool> {
    validate_child_basename(name)?;
    let file_fd = nonnegative_fd(file_fd, "inspect staged descriptor")?;
    let created = rustix::fs::fstat(borrowed(file_fd))
        .map_err(|error| os_error(error, "inspect staged descriptor"))?;
    let parent_fd = nonnegative_fd(parent_fd, "inspect staged child")?;
    let current = rustix::fs::statat(borrowed(parent_fd), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect staged child"))?;
    Ok(FileType::from_raw_mode(created.st_mode).is_file()
        && FileType::from_raw_mode(current.st_mode).is_file()
        && created.st_dev == current.st_dev
        && created.st_ino == current.st_ino)
}

pub(crate) fn remove_matching_child(
    parent_fd: i32,
    name: &str,
    file_fd: i32,
) -> NativeResult<&'static str> {
    match file_matches_child(parent_fd, name, file_fd) {
        Ok(false) => return Ok("preserved"),
        Err(error) if error.status == "ENOENT" => return Ok("name-absent"),
        Err(error) => return Err(error),
        Ok(true) => {}
    }
    // This is not atomic conditional unlink. Preserve observed substitutions;
    // a peer able to replace the leaf in this final gap still needs coordination.
    match rustix::fs::unlinkat(borrowed(parent_fd), name, AtFlags::empty()) {
        Ok(()) => Ok("removed"),
        Err(rustix::io::Errno::NOENT) => Ok("name-absent"),
        Err(error) => Err(os_error(error, "remove staged child")),
    }
}

fn same_identity(left: &rustix::fs::Stat, right: &rustix::fs::Stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

fn inspect_child(
    parent_fd: i32,
    name: impl Arg,
    operation: &str,
) -> NativeResult<Option<rustix::fs::Stat>> {
    match rustix::fs::statat(borrowed(parent_fd), name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(current) => Ok(Some(current)),
        Err(rustix::io::Errno::NOENT) => Ok(None),
        Err(error) => Err(os_error(error, operation)),
    }
}

fn directory_name_matches_fd(parent_fd: i32, name: &str, directory_fd: i32) -> NativeResult<bool> {
    let directory_fd = nonnegative_fd(directory_fd, "inspect owned directory descriptor")?;
    let opened = rustix::fs::fstat(borrowed(directory_fd))
        .map_err(|error| os_error(error, "inspect owned directory descriptor"))?;
    let parent_fd = nonnegative_fd(parent_fd, "inspect owned directory name")?;
    let Some(current) = inspect_child(parent_fd, name, "inspect owned directory name")? else {
        return Ok(false);
    };
    Ok(FileType::from_raw_mode(opened.st_mode).is_dir()
        && FileType::from_raw_mode(current.st_mode).is_dir()
        && same_identity(&opened, &current))
}

#[cfg(target_os = "macos")]
fn directory_name_matches_receipt(
    parent_fd: i32,
    name: &str,
    receipt: &crate::darwin_security::DarwinSecurityReceipt,
) -> NativeResult<bool> {
    let Some(current) = inspect_child(parent_fd, name, "inspect private clone directory name")? else {
        return Ok(false);
    };
    Ok(FileType::from_raw_mode(current.st_mode).is_dir() && receipt.matches_identity(&current))
}

#[cfg(target_os = "macos")]
fn file_name_matches_receipt(
    parent_fd: i32,
    name: &str,
    receipt: &crate::darwin_security::DarwinSecurityReceipt,
) -> NativeResult<bool> {
    let Some(current) = inspect_child(parent_fd, name, "inspect cloned payload name")? else {
        return Ok(false);
    };
    Ok(FileType::from_raw_mode(current.st_mode).is_file() && receipt.matches_identity(&current))
}

#[cfg(target_os = "macos")]
fn file_path_matches_receipt(
    root_fd: i32,
    rel_path: &str,
    receipt: &crate::darwin_security::DarwinSecurityReceipt,
) -> NativeResult<bool> {
    if !rel_path.contains('/') {
        file_name_matches_receipt(root_fd, rel_path, receipt)
    } else {
        let (parent, name) = open_parent(root_fd, rel_path)?;
        file_name_matches_receipt(parent.as_raw_fd(), name, receipt)
    }
}

fn directory_entry_matches_fd(
    parent_fd: i32,
    name: &CStr,
    directory_fd: i32,
) -> NativeResult<bool> {
    let opened = rustix::fs::fstat(borrowed(directory_fd))
        .map_err(|error| os_error(error, "inspect opened cleanup child"))?;
    let Some(current) = inspect_child(parent_fd, name, "inspect cleanup child name")? else {
        return Ok(false);
    };
    Ok(FileType::from_raw_mode(opened.st_mode).is_dir()
        && FileType::from_raw_mode(current.st_mode).is_dir()
        && same_identity(&opened, &current))
}

#[cfg(any(target_os = "linux", test))]
fn owned_tree_removal_available_with_probe(
    parent_fd: i32,
    probe: impl FnOnce(i32, &CStr) -> NativeResult<OwnedFd>,
) -> bool {
    parent_fd >= 0 && probe(parent_fd, c".").is_ok()
}

#[cfg(target_os = "linux")]
pub fn owned_tree_removal_available(parent_fd: i32) -> bool {
    // Probe the same openat2 flags as descent; never substitute openat.
    owned_tree_removal_available_with_probe(parent_fd, open_cleanup_directory)
}

#[cfg(target_os = "macos")]
pub fn owned_tree_removal_available(parent_fd: i32) -> bool {
    parent_fd >= 0
        && rustix::fs::fstat(borrowed(parent_fd))
            .is_ok_and(|stat| FileType::from_raw_mode(stat.st_mode).is_dir())
        && rustix::fs::fstatfs(borrowed(parent_fd)).is_ok()
}

#[cfg(target_os = "linux")]
pub(crate) fn open_cleanup_directory(parent_fd: i32, name: &CStr) -> NativeResult<OwnedFd> {
    use rustix::fs::{ResolveFlags, openat2};

    openat2(
        borrowed(parent_fd),
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS | ResolveFlags::NO_XDEV,
    )
    .map_err(|error| os_error(error, "open owned cleanup child without mount crossing"))
}

#[cfg(target_os = "macos")]
pub(crate) fn open_cleanup_directory(parent_fd: i32, name: &CStr) -> NativeResult<OwnedFd> {
    let child = rustix::fs::openat(
        borrowed(parent_fd),
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| os_error(error, "open owned cleanup child"))?;
    let parent_fs = rustix::fs::fstatfs(borrowed(parent_fd))
        .map_err(|error| os_error(error, "inspect owned cleanup parent mount"))?;
    let child_fs = rustix::fs::fstatfs(child.as_fd())
        .map_err(|error| os_error(error, "inspect owned cleanup child mount"))?;
    // SAFETY: macOS fsid_t is exactly two initialized i32 values in statfs.
    let same_mount = unsafe {
        libc::memcmp(
            (&parent_fs.f_fsid as *const libc::fsid_t).cast(),
            (&child_fs.f_fsid as *const libc::fsid_t).cast(),
            std::mem::size_of::<libc::fsid_t>(),
        ) == 0
    };
    if !same_mount {
        return Err(native_error("EXDEV", "owned tree cleanup cannot cross mounts"));
    }
    Ok(child)
}

fn remove_owned_file_child_with_hook(
    directory_fd: i32,
    name: &CStr,
    expected: &rustix::fs::Stat,
    before_unlink: impl FnOnce() -> rustix::io::Result<()>,
) -> NativeResult<()> {
    // This remains a pathname unlink, not an atomic expected-identity unlink.
    match before_unlink().and_then(|()| {
        rustix::fs::unlinkat(borrowed(directory_fd), name, AtFlags::empty())
    }) {
        Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error @ (rustix::io::Errno::ISDIR | rustix::io::Errno::PERM)) => {
            let Some(current) = inspect_child(directory_fd, name, "reinspect owned file child")? else {
                return Ok(());
            };
            let current_type = FileType::from_raw_mode(current.st_mode);
            if current_type.is_dir()
                || current_type != FileType::from_raw_mode(expected.st_mode)
                || !same_identity(expected, &current)
            {
                return Err(native_error(
                    "path-mismatch",
                    "owned tree file child changed during removal",
                ));
            }
            Err(os_error(error, "remove owned file child"))
        }
        Err(error) => Err(os_error(error, "remove owned file child")),
    }
}

fn remove_directory_contents_with_hook(
    directory_fd: i32,
    root_device: u64,
    before_entry_stat: &mut impl FnMut(&CStr),
) -> NativeResult<()> {
    let mut directory = Dir::read_from(borrowed(directory_fd))
        .map_err(|error| os_error(error, "open owned directory stream"))?;
    let mut names = Vec::new();
    for entry in &mut directory {
        let entry = entry.map_err(|error| os_error(error, "read owned directory entry"))?;
        if !matches!(entry.file_name().to_bytes(), b"." | b"..") {
            names.push((entry.file_name().to_owned(), entry.ino()));
        }
    }
    drop(directory);

    for (name, enumerated_inode) in names {
        before_entry_stat(name.as_c_str());
        let Some(current) = inspect_child(directory_fd, name.as_c_str(), "inspect owned tree entry")? else {
            continue;
        };
        // Darwin and Linux expose different widths for these identity fields.
        #[allow(clippy::unnecessary_cast)]
        if current.st_dev as u64 != root_device || current.st_ino as u64 != enumerated_inode {
            return Err(native_error(
                "path-mismatch",
                "owned tree entry changed after enumeration",
            ));
        }
        if FileType::from_raw_mode(current.st_mode).is_dir() {
            let child = open_cleanup_directory(directory_fd, name.as_c_str())?;
            let opened = rustix::fs::fstat(child.as_fd())
                .map_err(|error| os_error(error, "inspect owned cleanup child"))?;
            if !same_identity(&opened, &current) {
                return Err(native_error(
                    "path-mismatch",
                    "owned tree child changed while opening",
                ));
            }
            remove_directory_contents_with_hook(
                child.as_raw_fd(),
                root_device,
                before_entry_stat,
            )?;
            if !directory_entry_matches_fd(directory_fd, name.as_c_str(), child.as_raw_fd())? {
                return Err(native_error(
                    "path-mismatch",
                    "owned tree child changed before removal",
                ));
            }
            match rustix::fs::unlinkat(
                borrowed(directory_fd),
                name.as_c_str(),
                AtFlags::REMOVEDIR,
            ) {
                Ok(()) => {}
                Err(
                    rustix::io::Errno::NOENT | rustix::io::Errno::NOTEMPTY | rustix::io::Errno::NOTDIR,
                ) => {
                    return Err(native_error(
                        "path-mismatch",
                        "owned tree child changed during removal",
                    ));
                }
                Err(error) => return Err(os_error(error, "remove owned directory child")),
            }
        } else {
            remove_owned_file_child_with_hook(
                directory_fd,
                name.as_c_str(),
                &current,
                || Ok(()),
            )?;
        }
    }
    Ok(())
}

fn remove_owned_tree_root_with_hook(
    parent_fd: i32,
    name: &str,
    expected: &rustix::fs::Stat,
    before_unlink: impl FnOnce() -> rustix::io::Result<()>,
) -> NativeResult<String> {
    // POSIX has no expected-identity unlink: a raced empty-directory replacement
    // may still be removed successfully, the documented bounded residual. Only
    // failed type-swap unlinks are normalized after no-follow reinspection.
    match before_unlink().and_then(|()| {
        rustix::fs::unlinkat(borrowed(parent_fd), name, AtFlags::REMOVEDIR)
    }) {
        Ok(()) => Ok("removed".to_owned()),
        Err(rustix::io::Errno::NOENT | rustix::io::Errno::NOTEMPTY) => {
            Ok("preserved".to_owned())
        }
        Err(error @ (rustix::io::Errno::NOTDIR | rustix::io::Errno::PERM)) => {
            let Some(current) = inspect_child(parent_fd, name, "reinspect owned tree root")? else {
                return Ok("preserved".to_owned());
            };
            let current_type = FileType::from_raw_mode(current.st_mode);
            if !current_type.is_dir()
                || current_type != FileType::from_raw_mode(expected.st_mode)
                || !same_identity(expected, &current)
            {
                return Ok("preserved".to_owned());
            }
            Err(os_error(error, "remove owned tree root"))
        }
        Err(error) => Err(os_error(error, "remove owned tree root")),
    }
}

fn remove_owned_tree_with_hook(
    parent_fd: i32,
    name: &str,
    directory_fd: i32,
    before_root_unlink: impl FnOnce(),
) -> NativeResult<String> {
    validate_child_basename(name)?;
    if !directory_name_matches_fd(parent_fd, name, directory_fd)? {
        return Ok("preserved".to_owned());
    }
    let root = rustix::fs::fstat(borrowed(directory_fd))
        .map_err(|error| os_error(error, "inspect owned tree root"))?;
    remove_directory_contents_with_hook(directory_fd, root.st_dev as u64, &mut |_| {})?;
    if !directory_name_matches_fd(parent_fd, name, directory_fd)? {
        return Ok("preserved".to_owned());
    }
    remove_owned_tree_root_with_hook(parent_fd, name, &root, || {
        before_root_unlink();
        Ok(())
    })
}

pub fn remove_owned_tree(
    parent_fd: i32,
    name: &str,
    directory_fd: i32,
) -> NativeResult<String> {
    remove_owned_tree_with_hook(parent_fd, name, directory_fd, || {})
}

fn remove_created_target_checked(
    root_fd: i32,
    rel_path: &str,
    target: &OwnedFd,
) -> NativeResult<()> {
    #[cfg(target_os = "macos")]
    // SAFETY: target is an open descriptor owned by the caller.
    unsafe {
        libc::fchflags(target.as_raw_fd(), 0);
    }
    let outcome = if !rel_path.contains('/') {
        remove_matching_child(root_fd, rel_path, target.as_raw_fd())?
    } else {
        let (parent, name) = open_parent(root_fd, rel_path)?;
        remove_matching_child(parent.as_raw_fd(), name, target.as_raw_fd())?
    };
    if outcome == "preserved" {
        return Err(native_error(
            "EIO",
            "clone cleanup preserved a substituted target",
        ));
    }
    Ok(())
}

fn with_cleanup_error(
    error: napi::Error<String>,
    cleanup: NativeResult<()>,
) -> napi::Error<String> {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => native_error(
            "EIO",
            format!("{}; cleanup failed: {}", error.reason, cleanup.reason),
        ),
    }
}

pub fn clone_file_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<i32> {
    clone_file_exclusive_with_sync(source_fd, target_root_fd, target_rel_path, true)
}

#[cfg(target_os = "linux")]
pub(crate) fn clone_file_exclusive_with_sync(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: &str,
    sync: bool,
) -> NativeResult<i32> {
    let target = create_exclusive_target(target_root_fd, target_rel_path)?;
    let cloned = if source_fd < 0 {
        Err(rustix::io::Errno::BADF)
    } else {
        rustix::fs::ioctl_ficlone(target.as_fd(), borrowed(source_fd))
    };
    if let Err(error) = cloned {
        let error = if matches!(
            error,
            rustix::io::Errno::NOTTY
                | rustix::io::Errno::INVAL
                | rustix::io::Errno::XDEV
                | rustix::io::Errno::NOSYS
        ) || error == rustix::io::Errno::NOTSUP
            || error == rustix::io::Errno::OPNOTSUPP
        {
            native_error("ENOTSUP", format!("FICLONE is unavailable: {error}"))
        } else {
            os_error(error, "FICLONE")
        };
        return Err(with_cleanup_error(
            error,
            remove_created_target_checked(target_root_fd, target_rel_path, &target),
        ));
    }
    if let Err(error) =
        rustix::fs::fchmod(target.as_fd(), Mode::from_bits_retain(0o600)).and_then(|()| {
            if sync {
                rustix::fs::fsync(target.as_fd())
            } else {
                Ok(())
            }
        })
    {
        return Err(with_cleanup_error(
            os_error(error, "normalize cloned file"),
            remove_created_target_checked(target_root_fd, target_rel_path, &target),
        ));
    }
    Ok(target.into_raw_fd())
}

#[cfg(target_os = "macos")]
fn inspect_clone_directory(
    fd: BorrowedFd<'_>,
    private_stage: bool,
) -> NativeResult<crate::darwin_security::DarwinSecurityReceipt> {
    let receipt = crate::darwin_security::inspect_security(fd)?;
    // SAFETY: geteuid has no preconditions.
    let effective_uid = unsafe { libc::geteuid() } as u32;
    let mode_allowed = if private_stage {
        receipt.mode & 0o7777 == 0o700
    } else {
        receipt.mode & 0o022 == 0
    };
    if !receipt.is_directory() || receipt.uid != effective_uid || !mode_allowed {
        return Err(native_error(
            "ENOTSUP",
            "cloning requires an owned directory with restrictive modes",
        ));
    }
    crate::darwin_security::require_receipt_no_acl(&receipt, "clone directory")?;
    Ok(receipt)
}

#[cfg(target_os = "macos")]
fn inspect_clone_stage(
    parent_fd: i32,
    stage_path: &str,
    stage_fd: BorrowedFd<'_>,
    expected: Option<&crate::darwin_security::DarwinSecurityReceipt>,
) -> NativeResult<crate::darwin_security::DarwinSecurityReceipt> {
    // Re-observe both descriptors. The earlier receipt is comparison evidence,
    // never authority for mutable owner, mode, flags, or ACL state.
    inspect_clone_directory(borrowed(parent_fd), false)?;
    let current = inspect_clone_directory(stage_fd, true)?;
    if expected.is_some_and(|expected| expected != &current) {
        return Err(native_error(
            "EIO",
            "private clone directory security facts changed",
        ));
    }
    if !directory_name_matches_receipt(parent_fd, stage_path, &current)? {
        return Err(native_error("EIO", "private clone directory identity changed"));
    }
    Ok(current)
}

#[cfg(target_os = "macos")]
fn assert_clone_payload(
    receipt: &crate::darwin_security::DarwinSecurityReceipt,
    operation: &str,
) -> NativeResult<()> {
    // SAFETY: geteuid has no preconditions.
    let effective_uid = unsafe { libc::geteuid() } as u32;
    if !receipt.is_file()
        || receipt.uid != effective_uid
        || receipt.mode & 0o7777 != 0o600
        || receipt.flags != 0
    {
        return Err(native_error(
            "EIO",
            format!("{operation} returned unexpected descriptor security facts"),
        ));
    }
    crate::darwin_security::require_receipt_no_acl(receipt, operation)
}

#[cfg(target_os = "macos")]
pub(crate) fn post_clone_security_error(error: napi::Error<String>) -> napi::Error<String> {
    // Once fclonefileat has materialized a payload, a failed security check is
    // not an unsupported-clone signal. Both native and JS callers may otherwise
    // retry ordinary copying for the original errno, even after successful cleanup.
    native_error(
        "EIO",
        format!(
            "cloned payload security failure ({}): {}",
            error.status, error.reason
        ),
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn clone_file_exclusive_with_sync(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: &str,
    sync: bool,
) -> NativeResult<i32> {
    use std::sync::atomic::{AtomicU64, Ordering};

    const CLONE_NOOWNERCOPY: u32 = 0x0002;
    static CLONE_COUNTER: AtomicU64 = AtomicU64::new(0);
    // Reject parent ACLs before creating any stage or materializing clone bytes.
    let target_root_fd = nonnegative_fd(target_root_fd, "inspect descriptor security facts")?;
    inspect_clone_directory(borrowed(target_root_fd), false)?;
    let source_fd = nonnegative_fd(source_fd, "inspect clone source")?;
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
    let mut stage = CloneStage {
        parent_fd: target_root_fd,
        name: stage_path,
        target: None,
        directory: None,
        receipt: None,
        payload_created: false,
    };
    let publication = (|| {
        rustix::fs::chmodat(
            borrowed(target_root_fd),
            stage.name.as_str(),
            Mode::from_bits_retain(0o700),
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|error| os_error(error, "normalize private clone staging directory"))?;
        stage.directory = Some(open_owned_beneath(
            target_root_fd,
            &stage.name,
            (OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
        )?);
        let stage_fd = stage.directory.as_ref().unwrap();
        rustix::fs::fchmod(stage_fd.as_fd(), Mode::from_bits_retain(0o700))
            .map_err(|error| os_error(error, "normalize private clone staging directory"))?;
        stage.receipt = Some(inspect_clone_stage(
            target_root_fd,
            &stage.name,
            stage_fd.as_fd(),
            None,
        )?);

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
            let code = match error.raw_os_error() {
                Some(libc::EXDEV) | Some(libc::ENOTSUP) | Some(libc::EINVAL) => "ENOTSUP",
                Some(libc::EACCES) => "EACCES",
                Some(libc::EPERM) => "EPERM",
                _ => "EIO",
            };
            return Err(native_error(code, format!("fclonefileat: {error}")));
        }
        stage.payload_created = true;
        stage.target = Some(open_owned_beneath(
            stage_fd.as_raw_fd(),
            "payload",
            (OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW).bits() as i32,
        )
        .map_err(post_clone_security_error)?);
        let target = stage.target.as_ref().unwrap();

        let normalize = || -> NativeResult<(
            crate::darwin_security::DarwinSecurityReceipt,
            crate::darwin_security::DarwinSecurityReceipt,
        )> {
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
            crate::darwin_security::clear_private_clone_acl(target.as_fd())?;
            rustix::fs::fchmod(target.as_fd(), Mode::from_bits_retain(0o600))
                .map_err(|error| os_error(error, "set cloned file mode"))?;
            clear_macos_xattrs(target.as_raw_fd())?;
            if sync {
                rustix::fs::fsync(target.as_fd())
                    .map_err(|error| os_error(error, "sync cloned file"))?;
            }
            let current_stage = inspect_clone_stage(
                target_root_fd,
                &stage.name,
                stage_fd.as_fd(),
                stage.receipt.as_ref(),
            )?;
            // This fused observation is both the ACL-clear readback and the exact
            // descriptor receipt staged for the post-rename handoff fence.
            let payload = crate::darwin_security::inspect_security(target.as_fd())?;
            assert_clone_payload(&payload, "cloned payload publication")?;
            if !file_name_matches_receipt(stage_fd.as_raw_fd(), "payload", &payload)? {
                return Err(native_error(
                    "EIO",
                    "cloned payload identity changed before publication",
                ));
            }
            Ok((current_stage, payload))
        };
        let (publication_stage_receipt, payload_receipt) =
            normalize().map_err(post_clone_security_error)?;
        stage.receipt = Some(publication_stage_receipt);
        rename_no_replace(
            stage_fd.as_raw_fd(),
            "payload",
            target_root_fd,
            target_rel_path,
        )
        .map_err(|error| {
            // Preserve already-terminal namespace errors such as EEXIST, but never
            // retry a different copy mechanism after materializing the clone.
            match error.status.as_str() {
                "EINVAL" | "ENOSYS" | "ENOTSUP" | "EOPNOTSUPP" | "EPERM" | "EXDEV" => {
                    post_clone_security_error(error)
                }
                _ => error,
            }
        })?;
        Ok(payload_receipt)
    })();
    let payload_receipt = publication.map_err(|error| with_cleanup_error(error, stage.cleanup()))?;
    stage.payload_created = false;
    let target = stage.target.as_ref().unwrap();
    if let Err(error) = stage.cleanup() {
        return Err(with_cleanup_error(
            error,
            remove_created_target_checked(target_root_fd, target_rel_path, target),
        ));
    }
    let handoff = || -> NativeResult<()> {
        let current = crate::darwin_security::inspect_security(target.as_fd())?;
        assert_clone_payload(&current, "cloned payload handoff")?;
        if current != payload_receipt {
            return Err(native_error(
                "EIO",
                "cloned payload security facts changed during publication",
            ));
        }
        if !file_path_matches_receipt(target_root_fd, target_rel_path, &current)? {
            return Err(native_error(
                "EIO",
                "cloned payload identity changed during publication",
            ));
        }
        Ok(())
    };
    if let Err(error) = handoff() {
        return Err(with_cleanup_error(
            post_clone_security_error(error),
            remove_created_target_checked(target_root_fd, target_rel_path, target),
        ));
    }
    Ok(stage.target.take().unwrap().into_raw_fd())
}

#[cfg(target_os = "macos")]
struct CloneStage {
    parent_fd: i32,
    name: String,
    // Close the payload before its parent, including on an error return.
    target: Option<OwnedFd>,
    directory: Option<OwnedFd>,
    receipt: Option<crate::darwin_security::DarwinSecurityReceipt>,
    payload_created: bool,
}

#[cfg(target_os = "macos")]
impl CloneStage {
    // Cleanup is explicit: its failures must remain part of the returned error.
    fn cleanup(&self) -> NativeResult<()> {
        let mut errors = Vec::new();
        if self.payload_created {
            let stage = self.directory
                .as_ref()
                .expect("a cloned payload has a retained private directory");
            let result = if let Some(target) = &self.target {
                remove_created_target_checked(stage.as_raw_fd(), "payload", target)
            } else {
                // fclonefileat created this payload inside our private directory,
                // but reopening it failed before a file descriptor was available.
                match rustix::fs::unlinkat(stage, "payload", AtFlags::empty()) {
                    Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
                    Err(error) => Err(os_error(error, "remove cloned payload")),
                }
            };
            if let Err(error) = result {
                errors.push(error.reason);
            }
        }
        let remove_directory = || -> NativeResult<()> {
            if let Some(stage) = &self.directory {
                let matches = if let Some(receipt) = &self.receipt {
                    directory_name_matches_receipt(self.parent_fd, &self.name, receipt)?
                } else {
                    directory_name_matches_fd(self.parent_fd, &self.name, stage.as_raw_fd())?
                };
                if !matches {
                    return Err(native_error(
                        "EIO",
                        "private clone directory identity changed",
                    ));
                }
            }
            rustix::fs::unlinkat(borrowed(self.parent_fd), self.name.as_str(), AtFlags::REMOVEDIR)
                .map_err(|error| os_error(error, "remove private clone directory"))
        };
        if let Err(error) = remove_directory() {
            errors.push(error.reason);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(native_error(
                "EIO",
                format!("private clone stage '{}': {}", self.name, errors.join("; ")),
            ))
        }
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
    let source_fd = nonnegative_fd(source_fd, "inspect copy source")?;
    let source_stat = rustix::fs::fstat(borrowed(source_fd))
        .map_err(|error| os_error(error, "inspect copy source"))?;
    let expected = u64::try_from(source_stat.st_size)
        .map_err(|_| native_error("EINVAL", "copy source has a negative size"))?;
    let target = create_exclusive_target(target_root_fd, target_rel_path)?;
    let copied =
        crate::file_copy::copy_file_ranges(source_fd, target.as_raw_fd(), expected, || Ok(()))
            .and_then(|outcome| match outcome {
                crate::file_copy::RangeCopyOutcome::Complete(bytes) if bytes == expected => {
                    Ok(bytes)
                }
                crate::file_copy::RangeCopyOutcome::Complete(_) => {
                    Err(native_error("EIO", "copy_file_range made no progress"))
                }
                crate::file_copy::RangeCopyOutcome::Unsupported { error, .. } => {
                    Err(native_error("ENOTSUP", error.reason))
                }
            });
    let target_offset = match copied {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = remove_created_target_checked(target_root_fd, target_rel_path, &target);
            return Err(error);
        }
    };
    if let Err(error) = rustix::fs::fchmod(target.as_fd(), Mode::from_bits_retain(0o600))
        .and_then(|()| rustix::fs::fsync(target.as_fd()))
    {
        let _ = remove_created_target_checked(target_root_fd, target_rel_path, &target);
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
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
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

    fn verify_opened_beneath(root_fd: RawFd, opened: OwnedFd) -> NativeResult<OwnedFd> {
        let root = root_path(root_fd)?;
        let opened_path = root_path(opened.as_raw_fd())?;
        if !std::path::Path::new(&opened_path).starts_with(std::path::Path::new(&root)) {
            return Err(native_error(
                "EXDEV",
                format!("opened path escaped root: {opened_path}"),
            ));
        }
        Ok(opened)
    }

    fn open_with_resolve_beneath(root_fd: RawFd, rel_path: &str, flags: i32) -> NativeResult<OwnedFd> {
        let path = CString::new(rel_path.as_bytes())
            .map_err(|_| native_error("EINVAL", "path contains a NUL byte"))?;
        let root_fd = super::nonnegative_fd(root_fd, "open path with O_RESOLVE_BENEATH")?;
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

    pub fn open_beneath(root_fd: RawFd, rel_path: &str, flags: i32) -> NativeResult<OwnedFd> {
        if rel_path.is_empty() || rel_path == "." {
            return verify_opened_beneath(root_fd, super::duplicate_cloexec(root_fd)?);
        }
        if resolve_beneath_available() {
            return open_with_resolve_beneath(root_fd, rel_path, flags);
        }
        let mut queue: VecDeque<String> = rel_path
            .split('/')
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .map(ToOwned::to_owned)
            .collect();
        let mut current = super::duplicate_cloexec(root_fd)?;
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
            current = super::duplicate_cloexec(root_fd)?;
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
    fn beneath_descriptors_are_close_on_exec() {
        for invalid in [-1, i32::MAX] {
            assert_eq!(duplicate_cloexec(invalid).unwrap_err().status, "EBADF");
        }
        let root = temp_root("cloexec");
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("file"), b"content").unwrap();
        let parent = fs::File::open(&root).unwrap();
        for explicit in [OFlags::empty(), OFlags::CLOEXEC] {
            for (name, flags) in [
                ("", OFlags::RDONLY),
                (".", OFlags::RDONLY),
                ("nested", OFlags::RDONLY | OFlags::DIRECTORY),
                ("file", OFlags::RDONLY),
                ("created", OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL),
            ] {
                let fd = open_beneath(parent.as_raw_fd(), name, (flags | explicit).bits() as i32).unwrap();
                // SAFETY: open_beneath returned an independently owned fd.
                let owned = unsafe { OwnedFd::from_raw_fd(fd) };
                let observed = rustix::io::fcntl_getfd(&owned).unwrap();
                assert!(observed.contains(rustix::io::FdFlags::CLOEXEC), "{name:?}, explicit={explicit:?}");
                if name.is_empty() || name == "." {
                    let expected = rustix::fs::fstat(&parent).unwrap();
                    let actual = rustix::fs::fstat(&owned).unwrap();
                    assert_eq!((actual.st_dev, actual.st_ino), (expected.st_dev, expected.st_ino));
                }
            }
            fs::remove_file(root.join("created")).unwrap();
        }
        assert!(parent.metadata().unwrap().is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn beneath_descriptors_do_not_survive_exec() {
        const TEST: &str = "unix::tests::beneath_descriptors_do_not_survive_exec";
        const INPUT: &str = "FS_SAFE_EXEC_FDS";
        if let Ok(input) = std::env::var(INPUT) {
            let values: Vec<i64> = input.split(',').map(|value| value.parse().unwrap()).collect();
            for (index, &fd) in values[..2].iter().enumerate() {
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                // SAFETY: raw fstat validates the possibly closed descriptor.
                let result = unsafe { libc::fstat(fd as i32, stat.as_mut_ptr()) };
                let same_file = result == 0 && {
                    // SAFETY: successful fstat initialized its output.
                    let stat = unsafe { stat.assume_init() };
                    stat.st_dev as i64 == values[2] && stat.st_ino as i64 == values[3]
                };
                assert_eq!(same_file, index == 0, "plain dup must survive; beneath fd must not");
            }
            return;
        }
        let root = temp_root("exec");
        let parent = fs::File::open(&root).unwrap();
        let control = rustix::io::dup(&parent).unwrap();
        let stat = parent.metadata().unwrap();
        use std::os::unix::fs::MetadataExt;
        for name in ["", "."] {
            let fd = open_beneath(parent.as_raw_fd(), name, OFlags::RDONLY.bits() as i32).unwrap();
            // SAFETY: open_beneath returned an independently owned fd.
            let owned = unsafe { OwnedFd::from_raw_fd(fd) };
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST])
                .env(INPUT, format!("{},{},{},{}", control.as_raw_fd(), owned.as_raw_fd(), stat.dev(), stat.ino()))
                .output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stdout));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn closes_only_the_exported_descriptor_and_preserves_close_errors() {
        const TEST: &str = "unix::tests::closes_only_the_exported_descriptor_and_preserves_close_errors";
        const CHILD: &str = "FS_SAFE_CLOSE_OWNED_FD_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            // Other tests may spawn a child that briefly retains this test's flock.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--test-threads=1"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "owned descriptor close child failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            return;
        }
        let root = temp_root("close-owned");
        fs::write(root.join("file"), b"owned").unwrap();
        let root_handle = fs::File::open(&root).unwrap();
        let fd = open_beneath(root_handle.as_raw_fd(), "file", OFlags::RDONLY.bits() as i32)
            .unwrap();
        assert_eq!(fstat_identity(fd).unwrap().size, 5.0);
        let lock = rustix::fs::FlockOperation::NonBlockingLockExclusive;
        rustix::fs::flock(borrowed(fd), lock).unwrap();
        let observer = fs::File::open(root.join("file")).unwrap();
        assert!(rustix::fs::flock(&observer, lock).is_err());
        close_owned_fd(fd).unwrap();
        rustix::fs::flock(&observer, lock).unwrap();
        assert!(root_handle.metadata().unwrap().is_dir());
        assert_eq!(close_owned_fd(-1).unwrap_err().status, "EBADF");
        assert_eq!(os_error(rustix::io::Errno::INTR, "close").status, "EINTR");
        drop(observer);
        drop(root_handle);
        fs::remove_dir_all(root).unwrap();
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
    fn direct_child_mkdir_reports_exactly_one_race_winner() {
        let root = temp_root("mkdir-child");
        let root_handle = std::sync::Arc::new(OpenOptions::new().read(true).open(&root).unwrap());
        let attempts = (0..16).map(|_| {
            let parent = std::sync::Arc::clone(&root_handle);
            std::thread::spawn(move || {
                mkdir_child_beneath(parent.as_raw_fd(), "raced", 0o700).unwrap()
            })
        }).collect::<Vec<_>>();
        let created = attempts.into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|created| *created)
            .count();
        assert_eq!(created, 1);
        assert!(!mkdir_child_beneath(root_handle.as_raw_fd(), "raced", 0o700).unwrap());
        fs::write(root.join("file"), b"preserve").unwrap();
        assert!(!mkdir_child_beneath(root_handle.as_raw_fd(), "file", 0o700).unwrap());
        for invalid in ["", ".", "..", "nested/child", "nul\0child"] {
            assert_eq!(
                mkdir_child_beneath(root_handle.as_raw_fd(), invalid, 0o700)
                    .unwrap_err()
                    .status,
                "EINVAL",
            );
        }
        assert_eq!(fs::read(root.join("file")).unwrap(), b"preserve");
        drop(root_handle);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_probe_requires_a_successful_open() {
        let root = temp_root("owned-probe");
        let parent = fs::File::open(&root).unwrap();
        let fd = parent.as_raw_fd();
        assert!(owned_tree_removal_available_with_probe(
            fd,
            |actual, name| {
                assert_eq!(actual, fd);
                assert_eq!(name, c".");
                Ok(parent.try_clone().unwrap().into())
            }
        ));
        for error in [
            rustix::io::Errno::NOSYS,
            rustix::io::Errno::INVAL,
            rustix::io::Errno::PERM,
            rustix::io::Errno::BADF,
            rustix::io::Errno::MFILE,
        ] {
            assert!(!owned_tree_removal_available_with_probe(fd, |_, _| {
                Err(os_error(error, "injected openat2 failure"))
            }));
        }
        assert!(!owned_tree_removal_available_with_probe(-1, |_, _| {
            panic!("invalid descriptor must not be borrowed")
        }));
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_rejects_an_enumerated_child_replacement() {
        let root = temp_root("owned-child-race");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        let directory = OpenOptions::new().read(true).open(&workspace).unwrap();
        let stat = rustix::fs::fstat(borrowed(directory.as_raw_fd())).unwrap();
        let mut swapped = false;
        let error = remove_directory_contents_with_hook(
            directory.as_raw_fd(),
            stat.st_dev as u64,
            &mut |name| {
                if name.to_bytes() == b"nested" && !swapped {
                    swapped = true;
                    fs::rename(workspace.join("nested"), workspace.join("original")).unwrap();
                    fs::create_dir(workspace.join("nested")).unwrap();
                    fs::write(workspace.join("nested/keep"), b"replacement").unwrap();
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.status, "path-mismatch");
        assert_eq!(fs::read(workspace.join("nested/keep")).unwrap(), b"replacement");
        assert_eq!(fs::read(workspace.join("original/owned")).unwrap(), b"owned");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_file_unlink_preserves_a_final_directory_replacement() {
        for injected in [
            None,
            Some(rustix::io::Errno::ISDIR),
            Some(rustix::io::Errno::PERM),
        ] {
            let root = temp_root("owned-file-unlink-race");
            let owned = b"owned\0\xff\n";
            let replacement = b"replacement\0\xfe\n";
            fs::write(root.join("leaf"), owned).unwrap();
            let directory = fs::File::open(&root).unwrap();
            let expected = rustix::fs::statat(
                directory.as_fd(),
                c"leaf",
                AtFlags::SYMLINK_NOFOLLOW,
            )
            .unwrap();

            let error = remove_owned_file_child_with_hook(
                directory.as_raw_fd(),
                c"leaf",
                &expected,
                || {
                    fs::rename(root.join("leaf"), root.join("original")).unwrap();
                    fs::create_dir(root.join("leaf")).unwrap();
                    fs::write(root.join("leaf/keep"), replacement).unwrap();
                    injected.map_or(Ok(()), Err)
                },
            )
            .unwrap_err();

            assert_eq!(error.status, "path-mismatch");
            assert!(fs::symlink_metadata(root.join("leaf")).unwrap().is_dir());
            assert_eq!(fs::read(root.join("leaf/keep")).unwrap(), replacement);
            assert_eq!(fs::read(root.join("original")).unwrap(), owned);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn owned_tree_file_unlink_keeps_operational_errors_for_the_expected_leaf() {
        let root = temp_root("owned-file-unlink-denied");
        let owned = b"owned\0\xff\n";
        fs::write(root.join("leaf"), owned).unwrap();
        let directory = fs::File::open(&root).unwrap();
        let expected = rustix::fs::statat(
            directory.as_fd(),
            c"leaf",
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .unwrap();
        for denied in [
            rustix::io::Errno::PERM,
            rustix::io::Errno::ISDIR,
            rustix::io::Errno::ACCESS,
        ] {
            let error = remove_owned_file_child_with_hook(
                directory.as_raw_fd(),
                c"leaf",
                &expected,
                || Err(denied),
            )
            .unwrap_err();
            let original = os_error(denied, "remove owned file child");
            assert_eq!(error.status, original.status);
            assert_eq!(error.reason, original.reason);
            assert_eq!(fs::read(root.join("leaf")).unwrap(), owned);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_file_unlink_reinspects_absence_and_leaf_identity_without_following_links() {
        for injected in [rustix::io::Errno::ISDIR, rustix::io::Errno::PERM] {
            for replacement in ["absent", "file", "symlink"] {
                let root = temp_root("owned-file-unlink-reinspect");
                fs::write(root.join("leaf"), b"owned").unwrap();
                let directory = fs::File::open(&root).unwrap();
                let expected = rustix::fs::statat(
                    directory.as_fd(),
                    c"leaf",
                    AtFlags::SYMLINK_NOFOLLOW,
                )
                .unwrap();
                let result = remove_owned_file_child_with_hook(
                    directory.as_raw_fd(),
                    c"leaf",
                    &expected,
                    || {
                        fs::rename(root.join("leaf"), root.join("original")).unwrap();
                        match replacement {
                            "file" => fs::write(root.join("leaf"), b"replacement").unwrap(),
                            "symlink" => {
                                std::os::unix::fs::symlink("original", root.join("leaf")).unwrap();
                            }
                            _ => {}
                        }
                        Err(injected)
                    },
                );
                if replacement == "absent" {
                    result.unwrap();
                } else {
                    assert_eq!(result.unwrap_err().status, "path-mismatch");
                    if replacement == "file" {
                        assert_eq!(fs::read(root.join("leaf")).unwrap(), b"replacement");
                    } else {
                        assert_eq!(
                            fs::read_link(root.join("leaf")).unwrap(),
                            std::path::Path::new("original")
                        );
                    }
                }
                assert_eq!(fs::read(root.join("original")).unwrap(), b"owned");
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn owned_tree_cleanup_rejects_mount_crossings() {
        let mounted = if cfg!(target_os = "linux") { "/proc" } else { "/dev" };
        if !std::path::Path::new(mounted).is_dir() {
            return;
        }
        let root = OpenOptions::new().read(true).open("/").unwrap();
        let name = std::ffi::CString::new(mounted.trim_start_matches('/')).unwrap();
        let error = open_cleanup_directory(root.as_raw_fd(), name.as_c_str()).unwrap_err();
        assert_eq!(error.status, "EXDEV");
    }

    #[test]
    fn owned_tree_cleanup_is_descriptor_relative_and_preserves_a_final_replacement() {
        let root = temp_root("owned-tree");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        let parent = OpenOptions::new().read(true).open(&root).unwrap();
        let directory = OpenOptions::new().read(true).open(&workspace).unwrap();

        let outcome = remove_owned_tree_with_hook(
            parent.as_raw_fd(),
            "workspace",
            directory.as_raw_fd(),
            || {
                fs::rename(&workspace, root.join("original")).unwrap();
                fs::create_dir(&workspace).unwrap();
                fs::create_dir(workspace.join("nested")).unwrap();
                fs::write(workspace.join("nested/keep"), b"replacement").unwrap();
            },
        )
        .unwrap();

        assert_eq!(outcome, "preserved");
        assert_eq!(fs::read(workspace.join("nested/keep")).unwrap(), b"replacement");
        assert!(fs::read_dir(root.join("original")).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_has_a_bounded_residual_for_a_final_empty_directory_swap() {
        use std::os::unix::fs::DirBuilderExt;

        let root = temp_root("owned-root-empty-residual");
        let workspace = root.join("workspace");
        let original = root.join("original");
        let keep = b"outside\0\xff\n";
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/keep"), keep).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), workspace.join("nested/link")).unwrap();
        let parent = fs::File::open(&root).unwrap();
        let directory = fs::File::open(&workspace).unwrap();

        let outcome = remove_owned_tree_with_hook(
            parent.as_raw_fd(),
            "workspace",
            directory.as_raw_fd(),
            || {
                fs::rename(&workspace, &original).unwrap();
                assert!(fs::read_dir(&original).unwrap().next().is_none());
                // REMOVEDIR needs no read access or recursive traversal of the replacement.
                fs::DirBuilder::new().mode(0o000).create(&workspace).unwrap();
            },
        )
        .unwrap();

        assert_eq!(outcome, "removed");
        assert_eq!(
            fs::symlink_metadata(&workspace).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        assert!(directory_name_matches_fd(
            parent.as_raw_fd(),
            "original",
            directory.as_raw_fd(),
        )
        .unwrap());
        assert!(fs::read_dir(&original).unwrap().next().is_none());
        assert_eq!(fs::read(root.join("outside/keep")).unwrap(), keep);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_preserves_a_final_root_type_replacement() {
        for replacement in ["file", "symlink"] {
            let root = temp_root("owned-root-type-race");
            let workspace = root.join("workspace");
            let keep = b"replacement\0\xfe\n";
            fs::create_dir(&workspace).unwrap();
            fs::write(workspace.join("owned"), b"owned\0\xff\n").unwrap();
            fs::create_dir(root.join("outside")).unwrap();
            fs::write(root.join("outside/keep"), keep).unwrap();
            let parent = fs::File::open(&root).unwrap();
            let directory = fs::File::open(&workspace).unwrap();

            let outcome = remove_owned_tree_with_hook(
                parent.as_raw_fd(),
                "workspace",
                directory.as_raw_fd(),
                || {
                    fs::rename(&workspace, root.join("original")).unwrap();
                    if replacement == "file" {
                        fs::write(&workspace, keep).unwrap();
                    } else {
                        std::os::unix::fs::symlink("outside", &workspace).unwrap();
                    }
                },
            )
            .unwrap();

            assert_eq!(outcome, "preserved");
            if replacement == "file" {
                assert!(fs::symlink_metadata(&workspace).unwrap().is_file());
                assert_eq!(fs::read(&workspace).unwrap(), keep);
            } else {
                assert!(fs::symlink_metadata(&workspace).unwrap().file_type().is_symlink());
                assert_eq!(
                    fs::read_link(&workspace).unwrap(),
                    std::path::Path::new("outside")
                );
            }
            assert_eq!(fs::read(root.join("outside/keep")).unwrap(), keep);
            assert!(fs::read_dir(root.join("original")).unwrap().next().is_none());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn owned_tree_root_unlink_reinspects_absence_and_replacements_without_following_links() {
        for injected in [rustix::io::Errno::NOTDIR, rustix::io::Errno::PERM] {
            for replacement in ["absent", "file", "directory", "symlink"] {
                let root = temp_root("owned-root-unlink-reinspect");
                let workspace = root.join("workspace");
                let owned = b"owned\0\xff\n";
                let keep = b"replacement\0\xfe\n";
                fs::create_dir(&workspace).unwrap();
                fs::write(workspace.join("owned"), owned).unwrap();
                let parent = fs::File::open(&root).unwrap();
                let directory = fs::File::open(&workspace).unwrap();
                let expected = rustix::fs::fstat(directory.as_fd()).unwrap();

                let outcome = remove_owned_tree_root_with_hook(
                    parent.as_raw_fd(),
                    "workspace",
                    &expected,
                    || {
                        fs::rename(&workspace, root.join("original")).unwrap();
                        match replacement {
                            "file" => fs::write(&workspace, keep).unwrap(),
                            "directory" => {
                                fs::create_dir(&workspace).unwrap();
                                fs::write(workspace.join("keep"), keep).unwrap();
                            }
                            "symlink" => {
                                std::os::unix::fs::symlink("original", &workspace).unwrap();
                            }
                            _ => {}
                        }
                        Err(injected)
                    },
                )
                .unwrap();

                assert_eq!(outcome, "preserved");
                match replacement {
                    "absent" => assert_eq!(
                        fs::symlink_metadata(&workspace).unwrap_err().kind(),
                        std::io::ErrorKind::NotFound
                    ),
                    "file" => assert_eq!(fs::read(&workspace).unwrap(), keep),
                    "directory" => assert_eq!(fs::read(workspace.join("keep")).unwrap(), keep),
                    "symlink" => assert_eq!(
                        fs::read_link(&workspace).unwrap(),
                        std::path::Path::new("original")
                    ),
                    _ => unreachable!(),
                }
                assert_eq!(fs::read(root.join("original/owned")).unwrap(), owned);
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn owned_tree_root_unlink_keeps_operational_errors_for_the_expected_directory() {
        let root = temp_root("owned-root-unlink-denied");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let parent = fs::File::open(&root).unwrap();
        let directory = fs::File::open(&workspace).unwrap();
        let expected = rustix::fs::fstat(directory.as_fd()).unwrap();
        for denied in [
            rustix::io::Errno::PERM,
            rustix::io::Errno::NOTDIR,
            rustix::io::Errno::ACCESS,
        ] {
            let error = remove_owned_tree_root_with_hook(
                parent.as_raw_fd(),
                "workspace",
                &expected,
                || Err(denied),
            )
            .unwrap_err();
            let original = os_error(denied, "remove owned tree root");
            assert_eq!(error.status, original.status);
            assert_eq!(error.reason, original.reason);
            assert!(directory_name_matches_fd(
                parent.as_raw_fd(),
                "workspace",
                directory.as_raw_fd(),
            )
            .unwrap());
            assert!(fs::read_dir(&workspace).unwrap().next().is_none());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_removes_nested_entries() {
        let root = temp_root("owned-tree-remove");
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        let parent = OpenOptions::new().read(true).open(&root).unwrap();
        let directory = OpenOptions::new().read(true).open(&workspace).unwrap();
        assert_eq!(
            remove_owned_tree(parent.as_raw_fd(), "workspace", directory.as_raw_fd()).unwrap(),
            "removed"
        );
        assert!(!workspace.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn post_clone_security_failure_stays_terminal_with_or_without_cleanup_errors() {
        for code in [
            "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL", "EPERM", "EACCES", "EIO",
        ] {
            for cleanup_failed in [false, true] {
                let error =
                    post_clone_security_error(native_error(code, "inspect cloned payload ACL"));
                let cleanup = if cleanup_failed {
                    Err(native_error("ENOTSUP", "cleanup unsupported"))
                } else {
                    Ok(())
                };
                let error = with_cleanup_error(error, cleanup);
                assert_eq!(error.status, "EIO");
                assert!(error.reason.starts_with(&format!(
                    "cloned payload security failure ({code}): inspect cloned payload ACL"
                )));
                assert_eq!(
                    error.reason.contains("cleanup failed: cleanup unsupported"),
                    cleanup_failed
                );
            }
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn clone_cleanup_reports_unremoved_private_stages() {
        let root = temp_root("clone-cleanup-report");
        fs::create_dir(root.join("stage")).unwrap();
        fs::write(root.join("stage/foreign"), b"preserve").unwrap();
        let parent = fs::File::open(&root).unwrap();
        let stage = CloneStage {
            parent_fd: parent.as_raw_fd(),
            name: "stage".to_owned(),
            target: None,
            directory: Some(OwnedFd::from(fs::File::open(root.join("stage")).unwrap())),
            receipt: None,
            payload_created: false,
        };
        let error = with_cleanup_error(
            native_error("ENOTSUP", "clone unsupported"),
            stage.cleanup(),
        );
        assert_eq!(error.status, "EIO");
        assert!(error.reason.contains("clone unsupported"));
        assert!(error.reason.contains("private clone stage 'stage'"));
        assert_eq!(fs::read(root.join("stage/foreign")).unwrap(), b"preserve");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn clone_stage_cleanup_keeps_retained_authority_after_name_replacement() {
        for reopened in [false, true] {
            let root = temp_root("clone-stage-replacement");
            fs::create_dir(root.join("stage")).unwrap();
            fs::write(root.join("stage/payload"), b"owned").unwrap();
            let parent = fs::File::open(&root).unwrap();
            let directory = OwnedFd::from(fs::File::open(root.join("stage")).unwrap());
            let stage = CloneStage {
                parent_fd: parent.as_raw_fd(),
                name: "stage".to_owned(),
                target: reopened.then(|| {
                    OwnedFd::from(fs::File::open(root.join("stage/payload")).unwrap())
                }),
                receipt: Some(crate::darwin_security::inspect_security(directory.as_fd()).unwrap()),
                directory: Some(directory),
                payload_created: true,
            };
            fs::rename(root.join("stage"), root.join("original-stage")).unwrap();
            fs::create_dir(root.join("stage")).unwrap();
            fs::write(root.join("stage/payload"), b"replacement").unwrap();
            let error = stage.cleanup().unwrap_err();
            assert_eq!(error.status, "EIO");
            assert!(error.reason.contains("private clone directory identity changed"));
            assert!(!root.join("original-stage/payload").exists());
            assert_eq!(fs::read(root.join("stage/payload")).unwrap(), b"replacement");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn clone_security_receipt_name_fences_reject_substitutions() {
        let root = temp_root("clone-security-receipt");
        let stage_path = root.join("stage");
        fs::create_dir(&stage_path).unwrap();
        fs::write(stage_path.join("payload"), b"owned").unwrap();
        let parent = fs::File::open(&root).unwrap();
        let stage = fs::File::open(&stage_path).unwrap();
        let payload = fs::File::open(stage_path.join("payload")).unwrap();
        let stage_receipt = crate::darwin_security::inspect_security(stage.as_fd()).unwrap();
        let payload_receipt = crate::darwin_security::inspect_security(payload.as_fd()).unwrap();
        assert!(directory_name_matches_receipt(
            parent.as_raw_fd(),
            "stage",
            &stage_receipt,
        )
        .unwrap());
        assert!(file_name_matches_receipt(
            stage.as_raw_fd(),
            "payload",
            &payload_receipt,
        )
        .unwrap());

        fs::rename(&stage_path, root.join("original-stage")).unwrap();
        fs::create_dir(&stage_path).unwrap();
        assert!(!directory_name_matches_receipt(
            parent.as_raw_fd(),
            "stage",
            &stage_receipt,
        )
        .unwrap());

        fs::rename(
            root.join("original-stage/payload"),
            root.join("original-stage/original-payload"),
        )
        .unwrap();
        fs::write(root.join("original-stage/payload"), b"substitute").unwrap();
        assert!(!file_name_matches_receipt(
            stage.as_raw_fd(),
            "payload",
            &payload_receipt,
        )
        .unwrap());

        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/target"), b"published").unwrap();
        let published = fs::File::open(root.join("nested/target")).unwrap();
        let published_receipt =
            crate::darwin_security::inspect_security(published.as_fd()).unwrap();
        assert!(file_path_matches_receipt(
            parent.as_raw_fd(),
            "nested/target",
            &published_receipt,
        )
        .unwrap());
        fs::rename(
            root.join("nested/target"),
            root.join("nested/original-target"),
        )
        .unwrap();
        fs::write(root.join("nested/target"), b"substitute").unwrap();
        assert!(!file_path_matches_receipt(
            parent.as_raw_fd(),
            "nested/target",
            &published_receipt,
        )
        .unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn rejected_copy_source_leaves_no_created_target() {
        let root = temp_root("copy-invalid-source");
        let parent = std::fs::File::open(&root).unwrap();
        assert_eq!(
            copy_file_range_exclusive(-1, parent.as_raw_fd(), "target")
                .err()
                .unwrap()
                .status,
            "EBADF"
        );
        assert!(!root.join("target").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_cleanup_removes_only_its_owned_nested_child() {
        for substituted in [false, true] {
            let root = temp_root("copy-cleanup");
            fs::create_dir(root.join("nested")).unwrap();
            let target_path = root.join("nested/target");
            fs::write(&target_path, b"owned").unwrap();
            let target = OwnedFd::from(std::fs::File::open(&target_path).unwrap());
            let parent = std::fs::File::open(&root).unwrap();
            if substituted {
                fs::rename(&target_path, root.join("nested/original")).unwrap();
                fs::write(&target_path, b"substitute").unwrap();
            }
            let _ = remove_created_target_checked(parent.as_raw_fd(), "nested/target", &target);
            if substituted {
                assert_eq!(fs::read(&target_path).unwrap(), b"substitute");
                assert_eq!(fs::read(root.join("nested/original")).unwrap(), b"owned");
            } else {
                assert!(!target_path.exists());
            }
            fs::remove_dir_all(root).unwrap();
        }
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
        assert!(root_handle.metadata().unwrap().is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn negative_roots_are_rejected_before_path_lookup() {
        for fd in [libc::AT_FDCWD, i32::MIN, -1] {
            for relative in ["", ".", "missing", "missing/child"] {
                let error = open_owned_beneath(fd, relative, directory_open_flags()).unwrap_err();
                assert_eq!(error.status, "EBADF", "fd {fd}, path {relative:?}");
            }
        }
        let error = open_owned_beneath(libc::AT_FDCWD, "../outside", directory_open_flags())
            .unwrap_err();
        assert_eq!(error.status, "EINVAL");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn nested_rename_keeps_parent_admission_order_with_negative_roots() {
        let root = temp_root("rename-negative-nested");
        fs::create_dir(root.join("parent")).unwrap();
        fs::write(root.join("parent/source"), b"source").unwrap();
        let source_parent = OpenOptions::new().read(true).open(&root).unwrap();
        for fd in [libc::AT_FDCWD, i32::MIN, -1] {
            let source = rename_no_replace(fd, "parent/source", fd, "parent/target")
                .unwrap_err();
            assert_eq!(source.status, "EBADF");
            let missing = rename_no_replace(source_parent.as_raw_fd(), "missing/source", fd, "parent/target")
                .unwrap_err();
            assert_eq!(missing.status, "ENOENT");
            let target = rename_no_replace(source_parent.as_raw_fd(), "parent/source", fd, "parent/target")
                .unwrap_err();
            assert_eq!(target.status, "EBADF");
            assert!(source_parent.metadata().unwrap().is_dir());
            assert_eq!(fs::read(root.join("parent/source")).unwrap(), b"source");
            assert!(!root.join("parent/target").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn direct_rename_rejects_negative_descriptors_in_argument_order() {
        let source_first = rename_no_replace(-1, "source", -1, "target").unwrap_err();
        assert_eq!(source_first.status, "EBADF");
        assert!(source_first.reason.contains("source root descriptor"));

        let root = temp_root("rename-negative-target");
        fs::write(root.join("source"), b"source").unwrap();
        let source_parent = OpenOptions::new().read(true).open(&root).unwrap();
        let target_second =
            rename_no_replace(source_parent.as_raw_fd(), "source", -1, "target").unwrap_err();
        assert_eq!(target_second.status, "EBADF");
        assert!(target_second.reason.contains("target root descriptor"));
        assert!(source_parent.metadata().unwrap().is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn direct_rename_rejects_invalid_and_closed_descriptors() {
        const TEST: &str =
            "unix::tests::direct_rename_rejects_invalid_and_closed_descriptors";
        const CLOSED_DESCRIPTOR_CASE: &str = "FS_SAFE_RENAME_CLOSED_DESCRIPTOR_CASE";

        if let Ok(case) = std::env::var(CLOSED_DESCRIPTOR_CASE) {
            let root = temp_root("rename-closed-descriptor");
            fs::write(root.join("source"), b"source").unwrap();
            match case.as_str() {
                "source" => {
                    let live_target = OpenOptions::new().read(true).open(&root).unwrap();
                    let closed_source = OpenOptions::new().read(true).open(&root).unwrap();
                    let closed_source_fd = closed_source.as_raw_fd();
                    drop(closed_source);
                    let error = rename_no_replace(
                        closed_source_fd,
                        "source",
                        live_target.as_raw_fd(),
                        "target",
                    )
                    .unwrap_err();
                    assert_eq!(error.status, "EBADF");
                    assert!(live_target.metadata().unwrap().is_dir());
                }
                "target" => {
                    let live_source = OpenOptions::new().read(true).open(&root).unwrap();
                    let closed_target = OpenOptions::new().read(true).open(&root).unwrap();
                    let closed_target_fd = closed_target.as_raw_fd();
                    drop(closed_target);
                    let error = rename_no_replace(
                        live_source.as_raw_fd(),
                        "source",
                        closed_target_fd,
                        "target",
                    )
                    .unwrap_err();
                    assert_eq!(error.status, "EBADF");
                    assert!(live_source.metadata().unwrap().is_dir());
                }
                _ => panic!("unexpected closed descriptor test case: {case}"),
            }
            fs::remove_dir_all(root).unwrap();
            return;
        }

        let root = temp_root("rename-invalid-descriptors");
        fs::write(root.join("source"), b"source").unwrap();
        let live_target = OpenOptions::new().read(true).open(&root).unwrap();
        let invalid_source = rename_no_replace(
            i32::MAX,
            "source",
            live_target.as_raw_fd(),
            "target",
        )
        .unwrap_err();
        assert_eq!(invalid_source.status, "EBADF");
        let invalid_target = rename_no_replace(
            live_target.as_raw_fd(),
            "source",
            i32::MAX,
            "target",
        )
        .unwrap_err();
        assert_eq!(invalid_target.status, "EBADF");
        assert!(live_target.metadata().unwrap().is_dir());
        fs::remove_dir_all(root).unwrap();

        for case in ["source", "target"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--test-threads=1"])
                .env(CLOSED_DESCRIPTOR_CASE, case)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "closed {case} descriptor child failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
        }
    }

    #[test]
    fn direct_rename_keeps_distinct_caller_descriptors_open() {
        let root = temp_root("rename-live-descriptors");
        let source_root = root.join("source-root");
        let target_root = root.join("target-root");
        fs::create_dir(&source_root).unwrap();
        fs::create_dir(&target_root).unwrap();
        fs::write(source_root.join("source"), b"source").unwrap();
        let source_parent = OpenOptions::new().read(true).open(&source_root).unwrap();
        let target_parent = OpenOptions::new().read(true).open(&target_root).unwrap();
        rename_no_replace(
            source_parent.as_raw_fd(),
            "source",
            target_parent.as_raw_fd(),
            "target",
        )
        .unwrap();
        assert!(source_parent.metadata().unwrap().is_dir());
        assert!(target_parent.metadata().unwrap().is_dir());
        assert_eq!(fs::read(target_root.join("target")).unwrap(), b"source");
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
        let opened = macos::open_beneath(
            root_handle.as_raw_fd(),
            "alias/file",
            OFlags::RDONLY.bits() as i32,
        )
        .unwrap();
        drop(opened);
        fs::remove_dir_all(base).unwrap();
    }
}
