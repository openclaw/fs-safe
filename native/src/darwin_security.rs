use std::ffi::c_void;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::ptr::NonNull;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::unix::os_error;
use crate::{NativeResult, into_napi, native_error};

const ACL_TYPE_EXTENDED: i32 = 0x0000_0100;
const ACL_FIRST_ENTRY: i32 = 0;

unsafe extern "C" {
    fn acl_get_fd_np(fd: i32, acl_type: i32) -> *mut c_void;
    fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
    fn acl_valid(acl: *mut c_void) -> i32;
    fn acl_init(count: i32) -> *mut c_void;
    fn acl_set_fd_np(fd: i32, acl: *mut c_void, acl_type: i32) -> i32;
    fn acl_free(object: *mut c_void) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AclState {
    Absent,
    Empty,
    Present,
}

impl AclState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Empty => "empty",
            Self::Present => "present",
        }
    }
}

struct OwnedAcl(NonNull<c_void>);

fn clear_errno() {
    // SAFETY: Darwin __error returns this thread's writable errno slot.
    unsafe { *libc::__error() = 0 };
}

impl Drop for OwnedAcl {
    fn drop(&mut self) {
        // SAFETY: this ACL was allocated by libc and is freed exactly once.
        unsafe { acl_free(self.0.as_ptr()) };
    }
}

fn acl_error(error: std::io::Error, operation: &str) -> napi::Error<String> {
    match error.raw_os_error() {
        Some(code) if code != 0 => os_error(rustix::io::Errno::from_raw_os_error(code), operation),
        _ => native_error("EIO", format!("{operation}: no operating-system error was reported")),
    }
}

fn absent_acl(error: std::io::Error) -> NativeResult<AclState> {
    match error.raw_os_error() {
        // acl_get_fd_np reports a missing FILESEC_ACL property as ENOENT.
        Some(libc::ENOENT) | Some(libc::ENOATTR) => Ok(AclState::Absent),
        _ => Err(acl_error(error, "inspect descriptor ACL")),
    }
}

fn first_entry_state(result: i32, error: std::io::Error, has_entry: bool) -> NativeResult<AclState> {
    match (result, has_entry) {
        // Darwin differs from Linux: zero means an entry was obtained.
        (0, true) => Ok(AclState::Present),
        // Only call this for ACL_FIRST_ENTRY on an owned, validated ACL. Its
        // iterator is private to this call, so EINVAL here means an empty ACL.
        (-1, false) if error.raw_os_error() == Some(libc::EINVAL) => Ok(AclState::Empty),
        (-1, false) => Err(acl_error(error, "inspect first descriptor ACL entry")),
        _ => Err(native_error(
            "EIO",
            "descriptor ACL entry inspection returned inconsistent facts",
        )),
    }
}

fn inspect_owned_acl(acl: &OwnedAcl) -> NativeResult<AclState> {
    clear_errno();
    // SAFETY: acl is an owned libc ACL allocation, never an arbitrary pointer.
    if unsafe { acl_valid(acl.0.as_ptr()) } != 0 {
        return Err(acl_error(
            std::io::Error::last_os_error(),
            "validate descriptor ACL",
        ));
    }
    let mut entry = std::ptr::null_mut();
    clear_errno();
    // SAFETY: the ACL is valid and entry is writable for one pointer.
    let result = unsafe { acl_get_entry(acl.0.as_ptr(), ACL_FIRST_ENTRY, &mut entry) };
    // Save errno before freeing the ACL or making any other libc call.
    let error = std::io::Error::last_os_error();
    first_entry_state(result, error, !entry.is_null())
}

pub(crate) fn inspect_acl(fd: BorrowedFd<'_>) -> NativeResult<AclState> {
    clear_errno();
    // SAFETY: fd remains borrowed throughout this synchronous inspection.
    let raw = unsafe { acl_get_fd_np(fd.as_raw_fd(), ACL_TYPE_EXTENDED) };
    let error = std::io::Error::last_os_error();
    let Some(acl) = NonNull::new(raw).map(OwnedAcl) else {
        return absent_acl(error);
    };
    inspect_owned_acl(&acl)
}

pub(crate) fn require_no_acl(fd: BorrowedFd<'_>, operation: &str) -> NativeResult<()> {
    if inspect_acl(fd)? == AclState::Present {
        return Err(native_error(
            "ENOTSUP",
            format!("{operation} requires no extended ACL entries"),
        ));
    }
    Ok(())
}

// Call only for the new clone payload inside its verified private directory.
// Clearing a publicly reachable inherited ACL cannot revoke an existing fd.
pub(crate) fn clear_acl(fd: BorrowedFd<'_>) -> NativeResult<()> {
    clear_errno();
    // SAFETY: acl_init allocates an empty ACL owned by this function.
    let raw = unsafe { acl_init(0) };
    let error = std::io::Error::last_os_error();
    let acl = NonNull::new(raw)
        .map(OwnedAcl)
        .ok_or_else(|| acl_error(error, "allocate empty ACL"))?;
    clear_errno();
    // SAFETY: fd and the owned ACL stay live through this synchronous call.
    let result = unsafe { acl_set_fd_np(fd.as_raw_fd(), acl.0.as_ptr(), ACL_TYPE_EXTENDED) };
    let error = std::io::Error::last_os_error();
    if result != 0 {
        return Err(acl_error(error, "clear cloned file ACL"));
    }
    if inspect_acl(fd)? == AclState::Present {
        return Err(native_error(
            "EIO",
            "cloned file retained ACL entries after clearing",
        ));
    }
    Ok(())
}

fn retain_descriptor(fd: i32) -> NativeResult<OwnedFd> {
    // Use the OS to validate raw N-API input before constructing a BorrowedFd.
    // SAFETY: fcntl accepts any integer fd and returns a new owned fd or -1.
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        return Err(acl_error(
            std::io::Error::last_os_error(),
            "retain ACL descriptor",
        ));
    }
    // SAFETY: F_DUPFD_CLOEXEC returned a fresh descriptor owned by this call.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn inspect_descriptor(fd: i32) -> NativeResult<AclState> {
    let retained = retain_descriptor(fd)?;
    inspect_acl(retained.as_fd())
}

#[napi(object)]
pub struct DarwinAclFacts {
    pub state: String,
}

#[napi(js_name = "inspectDarwinAcl")]
pub fn inspect_darwin_acl(env: Env, fd: i32) -> Result<DarwinAclFacts> {
    // No worker, callback, or await can outlive the owned duplicate.
    into_napi(
        env,
        inspect_descriptor(fd).map(|state| DarwinAclFacts {
            state: state.as_str().to_owned(),
        }),
    )
}

#[cfg(test)]
#[path = "darwin_security_tests.rs"]
mod tests;
