//! One-way publication on explicitly admitted local filesystems. This is not
//! source-identity CAS: callers must exclude source namespace writers.
use napi::{Env, Result};
use napi_derive::napi;
use rustix::fs::{AtFlags, FileType};
use crate::{NativeResult, into_napi, native_error, unix, validate_child_basename};

fn filesystem(fd: i32) -> NativeResult<String> {
    unix::nonnegative_fd(fd, "publication filesystem")?;
    let stat = rustix::fs::fstat(unix::borrowed(fd))
        .map_err(|e| unix::os_error(e, "publication parent"))?;
    if !FileType::from_raw_mode(stat.st_mode).is_dir() {
        return Err(native_error("ENOTDIR", "publication parent is not a directory"));
    }
    let info = rustix::fs::fstatfs(unix::borrowed(fd))
        .map_err(|e| unix::os_error(e, "publication filesystem"))?;
    #[cfg(target_os = "macos")]
    let name = {
        // Kernel initializes this fixed-size, NUL-terminated filesystem name.
        let bytes: Vec<u8> = info.f_fstypename.iter().take_while(|c| **c != 0)
            .map(|c| *c as u8).collect();
        match bytes.as_slice() {
            b"apfs" if info.f_flags & libc::MNT_LOCAL as u32 != 0 => "apfs",
            b"hfs" if info.f_flags & libc::MNT_LOCAL as u32 != 0 => "hfs",
            _ => return Err(native_error("ENOTSUP", "publication requires local APFS or HFS")),
        }
    };
    #[cfg(target_os = "linux")]
    let name = match info.f_type as u64 {
        0xef53 => "ext", 0x58465342 => "xfs", 0x9123683e => "btrfs", 0x01021994 => "tmpfs",
        _ => return Err(native_error("ENOTSUP", "publication requires ext, XFS, Btrfs or tmpfs")),
    };
    Ok(name.to_owned())
}

#[napi(js_name = "entryPublicationFilesystem")]
pub fn entry_publication_filesystem(env: Env, fd: i32) -> Result<String> {
    into_napi(env, filesystem(fd))
}

#[napi(object)]
pub struct EntryPublicationTransition {
    pub outcome: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

fn failure(outcome: &str, error: crate::NativeError) -> EntryPublicationTransition {
    EntryPublicationTransition {
        outcome: outcome.to_owned(), error_code: Some(error.status), error_message: Some(error.reason),
    }
}

fn admit(source_parent: i32, name: &str, source_fd: i32, target_parent: i32, target: &str) -> NativeResult<()> {
    validate_child_basename(name)?;
    validate_child_basename(target)?;
    filesystem(source_parent)?;
    filesystem(target_parent)?;
    unix::nonnegative_fd(source_fd, "publication source")?;
    let held = rustix::fs::fstat(unix::borrowed(source_fd))
        .map_err(|e| unix::os_error(e, "publication source descriptor"))?;
    let named = rustix::fs::statat(unix::borrowed(source_parent), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|e| unix::os_error(e, "publication source name"))?;
    let parent = rustix::fs::fstat(unix::borrowed(source_parent))
        .map_err(|e| unix::os_error(e, "publication source parent"))?;
    let destination = rustix::fs::fstat(unix::borrowed(target_parent))
        .map_err(|e| unix::os_error(e, "publication target parent"))?;
    if held.st_dev != parent.st_dev || held.st_dev != destination.st_dev {
        return Err(native_error("EXDEV", "publication cannot cross devices"));
    }
    let kind = FileType::from_raw_mode(held.st_mode);
    if !(kind.is_dir() || kind.is_file() || kind.is_symlink()) ||
        (!kind.is_dir() && held.st_nlink != 1) ||
        named.st_dev != held.st_dev || named.st_ino != held.st_ino ||
        FileType::from_raw_mode(named.st_mode) != kind {
        return Err(native_error("path-mismatch", "publication source no longer names the retained entry"));
    }
    // Darwin RENAME_EXCL permits a case-only rename of the source itself.
    // Observe the destination through the retained parent so an existing alias
    // cannot exploit that exception. Later distinct entrants are syscall-fenced;
    // source-name stability remains the caller's explicit namespace contract.
    match rustix::fs::statat(unix::borrowed(target_parent), target, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => return Err(native_error("EEXIST", "publication destination already exists")),
        Err(rustix::io::Errno::NOENT) => {},
        Err(error) => return Err(unix::os_error(error, "publication destination admission")),
    }
    Ok(())
}

#[napi(js_name = "publishRetainedEntryNoReplace")]
pub fn publish_retained_entry_no_replace(
    source_parent: i32, name: String, source_fd: i32, target_parent: i32, target: String,
) -> EntryPublicationTransition {
    if let Err(error) = admit(source_parent, &name, source_fd, target_parent, &target) {
        return failure("not-published", error);
    }
    // Reuse the syscall owner. No pathname fallback, copying, or compensation.
    // Namespace stability between admission and this call is a caller contract.
    match unix::rename_no_replace(source_parent, &name, target_parent, &target) {
        Ok(()) => EntryPublicationTransition {
            outcome: "committed".to_owned(), error_code: None, error_message: None,
        },
        Err(error) => {
            // Only determinate rejection codes on the admitted local filesystems.
            // EIO/EINTR and any unknown native failure retain both locations.
            let outcome = match error.status.as_str() {
                "EEXIST" | "EXDEV" | "ENOSYS" | "ENOTSUP" | unix::RENAME_NOREPLACE_UNSUPPORTED => "not-published",
                _ => "indeterminate",
            };
            failure(outcome, error)
        }
    }
}
