use std::ffi::c_void;
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::ptr::NonNull;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::unix::os_error;
use crate::{NativeResult, into_napi, native_error};

const ACL_TYPE_EXTENDED: i32 = 0x0000_0100;
const ACL_FIRST_ENTRY: i32 = 0;
const ACL_NEXT_ENTRY: i32 = -1;
const ACL_ENTRY_FILE_INHERIT: i32 = 1 << 5;
const ACL_ENTRY_DIRECTORY_INHERIT: i32 = 1 << 6;
const FILESEC_OWNER: i32 = 1;
const FILESEC_GROUP: i32 = 2;
const FILESEC_MODE: i32 = 4;
const FILESEC_ACL: i32 = 5;

unsafe extern "C" {
    fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
    fn acl_get_flagset_np(object: *mut c_void, flagset: *mut *mut c_void) -> i32;
    fn acl_get_flag_np(flagset: *mut c_void, flag: i32) -> i32;
    fn acl_valid(acl: *mut c_void) -> i32;
    fn acl_init(count: i32) -> *mut c_void;
    fn acl_set_fd_np(fd: i32, acl: *mut c_void, acl_type: i32) -> i32;
    fn acl_free(object: *mut c_void) -> i32;
    fn filesec_init() -> *mut c_void;
    fn filesec_free(filesec: *mut c_void);
    fn filesec_get_property(filesec: *mut c_void, property: i32, value: *mut c_void) -> i32;
    fn filesec_query_property(filesec: *mut c_void, property: i32, valid: *mut i32) -> i32;
    #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
    fn fstatx_np(fd: i32, stat: *mut libc::stat, filesec: *mut c_void) -> i32;
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
struct OwnedFileSec(NonNull<c_void>);

#[derive(Clone, Copy)]
enum InheritanceTarget {
    File,
    Directory,
}

/// Frozen facts from one descriptor-bound fstatx_np call. Callers must obtain a
/// fresh receipt after any interval in which security metadata can change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DarwinSecurityReceipt {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) mode: rustix::fs::RawMode,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) flags: u32,
    pub(crate) acl: AclState,
}

impl DarwinSecurityReceipt {
    fn from_stat(stat: &libc::stat, acl: AclState) -> Self {
        Self {
            device: stat.st_dev as u64,
            inode: stat.st_ino,
            mode: stat.st_mode,
            uid: stat.st_uid,
            gid: stat.st_gid,
            flags: stat.st_flags,
            acl,
        }
    }

    pub(crate) fn matches_identity(&self, stat: &rustix::fs::Stat) -> bool {
        self.device == stat.st_dev as u64 && self.inode == stat.st_ino
    }

    pub(crate) fn is_directory(&self) -> bool {
        rustix::fs::FileType::from_raw_mode(self.mode).is_dir()
    }

    pub(crate) fn is_file(&self) -> bool {
        rustix::fs::FileType::from_raw_mode(self.mode).is_file()
    }
}

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

impl Drop for OwnedFileSec {
    fn drop(&mut self) {
        // SAFETY: this filesec was allocated by filesec_init and is freed once.
        unsafe { filesec_free(self.0.as_ptr()) };
    }
}

fn acl_error(error: std::io::Error, operation: &str) -> napi::Error<String> {
    match error.raw_os_error() {
        Some(code) if code != 0 => os_error(rustix::io::Errno::from_raw_os_error(code), operation),
        _ => native_error(
            "EIO",
            format!("{operation}: no operating-system error was reported"),
        ),
    }
}

fn acl_entry_state(result: i32, error: std::io::Error, has_entry: bool) -> NativeResult<AclState> {
    match (result, has_entry) {
        // Darwin differs from Linux: zero means an entry was obtained.
        (0, true) => Ok(AclState::Present),
        // Only call this for FIRST/NEXT on an owned, validated ACL. Its iterator
        // is private to this call, so EINVAL means there are no more entries.
        (-1, false) if error.raw_os_error() == Some(libc::EINVAL) => Ok(AclState::Empty),
        (-1, false) => Err(acl_error(error, "inspect descriptor ACL entry")),
        _ => Err(native_error(
            "EIO",
            "descriptor ACL entry inspection returned inconsistent facts",
        )),
    }
}

fn entry_inherits(entry: NonNull<c_void>, target: InheritanceTarget) -> NativeResult<bool> {
    let mut flagset = std::ptr::null_mut();
    clear_errno();
    // SAFETY: entry belongs to the live, validated ACL being inspected. The
    // returned flagset is borrowed from that ACL and must not be freed.
    let result = unsafe { acl_get_flagset_np(entry.as_ptr(), &mut flagset) };
    let error = std::io::Error::last_os_error();
    if result != 0 {
        return Err(acl_error(error, "inspect descriptor ACL entry flags"));
    }
    if flagset.is_null() {
        return Err(native_error(
            "EIO",
            "descriptor ACL entry flags are missing",
        ));
    }
    let flags: &[i32] = match target {
        InheritanceTarget::File => &[ACL_ENTRY_FILE_INHERIT],
        // Conservatively reject file-inheriting entries on a directory parent
        // as well, including entries intended only for later descendants.
        InheritanceTarget::Directory => &[ACL_ENTRY_FILE_INHERIT, ACL_ENTRY_DIRECTORY_INHERIT],
    };
    for &flag in flags {
        clear_errno();
        // SAFETY: flagset remains borrowed from the live ACL and flag is a
        // Darwin sys/acl.h inheritance flag.
        let result = unsafe { acl_get_flag_np(flagset, flag) };
        let error = std::io::Error::last_os_error();
        match result {
            0 => {}
            1 => return Ok(true),
            -1 => return Err(acl_error(error, "read descriptor ACL inheritance flag")),
            _ => {
                return Err(native_error(
                    "EIO",
                    "descriptor ACL flag inspection is inconsistent",
                ));
            }
        }
    }
    Ok(false)
}

fn inspect_owned_acl(
    acl: &OwnedAcl,
    inheritance_target: Option<InheritanceTarget>,
) -> NativeResult<AclState> {
    clear_errno();
    // SAFETY: acl is an owned libc ACL allocation, never an arbitrary pointer.
    if unsafe { acl_valid(acl.0.as_ptr()) } != 0 {
        return Err(acl_error(
            std::io::Error::last_os_error(),
            "validate descriptor ACL",
        ));
    }
    let mut entry_id = ACL_FIRST_ENTRY;
    loop {
        // Darwin leaves the output untouched at end-of-list.
        let mut entry = std::ptr::null_mut();
        clear_errno();
        // SAFETY: the ACL is valid and entry is writable for one pointer. Only
        // this loop advances its iterator, from FIRST through successive NEXT.
        let result = unsafe { acl_get_entry(acl.0.as_ptr(), entry_id, &mut entry) };
        let error = std::io::Error::last_os_error();
        if acl_entry_state(result, error, !entry.is_null())? == AclState::Empty {
            return Ok(AclState::Empty);
        }
        match inheritance_target {
            None => return Ok(AclState::Present),
            Some(target) if entry_inherits(NonNull::new(entry).unwrap(), target)? => {
                return Ok(AclState::Present);
            }
            Some(_) => entry_id = ACL_NEXT_ENTRY,
        }
    }
}

pub(crate) fn inspect_acl(fd: BorrowedFd<'_>) -> NativeResult<AclState> {
    // acl_get_fd_np is implemented on top of fstatx_np but can misclassify an
    // internal ACL-buffer allocation failure as ENOENT. Share the fused,
    // completion-checked path even when the caller only needs ACL state.
    Ok(inspect_security(fd)?.acl)
}

fn filesec_property_valid(filesec: &OwnedFileSec, property: i32) -> NativeResult<bool> {
    let mut valid = 0;
    clear_errno();
    // SAFETY: filesec is live and valid is writable for one integer.
    let result = unsafe { filesec_query_property(filesec.0.as_ptr(), property, &mut valid) };
    let error = std::io::Error::last_os_error();
    if result != 0 {
        return Err(acl_error(error, "query descriptor security facts"));
    }
    if valid < 0 {
        return Err(native_error(
            "EIO",
            "descriptor security facts returned an invalid property state",
        ));
    }
    Ok(valid != 0)
}

fn require_complete_filesec(filesec: &OwnedFileSec) -> NativeResult<()> {
    // Apple libc populates these scalar properties only after its extended-stat
    // ACL buffer is complete. fstatx_np can otherwise return zero after an
    // internal realloc failure, leaving a fresh filesec wholly unset.
    for property in [FILESEC_OWNER, FILESEC_GROUP, FILESEC_MODE] {
        if !filesec_property_valid(filesec, property)? {
            return Err(native_error(
                "EIO",
                "descriptor security observation returned incomplete facts",
            ));
        }
    }
    Ok(())
}

fn filesec_acl_state(
    filesec: &OwnedFileSec,
    inheritance_target: Option<InheritanceTarget>,
) -> NativeResult<AclState> {
    require_complete_filesec(filesec)?;
    if !filesec_property_valid(filesec, FILESEC_ACL)? {
        // Once the mandatory scalar properties prove population completed, a
        // fresh filesec leaves FILESEC_ACL unset only for KAUTH_FILESEC_NOACL.
        return Ok(AclState::Absent);
    }
    let mut raw_acl: *mut c_void = std::ptr::null_mut();
    clear_errno();
    // SAFETY: filesec is live and raw_acl is writable for one owned ACL pointer.
    let result = unsafe {
        filesec_get_property(
            filesec.0.as_ptr(),
            FILESEC_ACL,
            (&mut raw_acl as *mut *mut c_void).cast(),
        )
    };
    let error = std::io::Error::last_os_error();
    if result != 0 {
        // The property was reported present above, so even ENOENT here is an
        // inconsistent/failing extraction rather than evidence of no ACL.
        return Err(acl_error(error, "extract descriptor ACL security facts"));
    }
    if raw_acl.is_null() || raw_acl as usize == 1 {
        // The value 1 is FILESEC's mutation-only REMOVE_ACL sentinel, never a
        // valid ACL returned by fstatx_np. Do not pass either value to acl_free.
        return Err(native_error(
            "EIO",
            "descriptor security facts returned an invalid ACL object",
        ));
    }
    // filesec_get_property returns a separately allocated ACL copy owned here.
    inspect_owned_acl(
        &OwnedAcl(NonNull::new(raw_acl).unwrap()),
        inheritance_target,
    )
}

fn read_descriptor_security(fd: BorrowedFd<'_>) -> NativeResult<(libc::stat, OwnedFileSec)> {
    clear_errno();
    // SAFETY: filesec_init returns either null or a newly allocated filesec.
    let raw_filesec = unsafe { filesec_init() };
    let error = std::io::Error::last_os_error();
    let filesec = OwnedFileSec(
        NonNull::new(raw_filesec)
            .ok_or_else(|| acl_error(error, "allocate descriptor security facts"))?,
    );
    let mut stat = MaybeUninit::<libc::stat>::zeroed();
    clear_errno();
    // SAFETY: fd remains borrowed and both output objects remain live for the
    // synchronous call. On success fstatx_np initializes the complete stat.
    let result = unsafe { fstatx_np(fd.as_raw_fd(), stat.as_mut_ptr(), filesec.0.as_ptr()) };
    let error = std::io::Error::last_os_error();
    if result != 0 {
        return Err(acl_error(error, "inspect descriptor security facts"));
    }
    // SAFETY: a successful fstatx_np initialized the stat output.
    let stat = unsafe { stat.assume_init() };
    Ok((stat, filesec))
}

pub(crate) fn inspect_security(fd: BorrowedFd<'_>) -> NativeResult<DarwinSecurityReceipt> {
    let (stat, filesec) = read_descriptor_security(fd)?;
    let acl = filesec_acl_state(&filesec, None)?;
    Ok(DarwinSecurityReceipt::from_stat(&stat, acl))
}

pub(crate) fn require_receipt_no_acl(
    receipt: &DarwinSecurityReceipt,
    operation: &str,
) -> NativeResult<()> {
    if receipt.acl == AclState::Present {
        return Err(native_error(
            "ENOTSUP",
            format!("{operation} requires no extended ACL entries"),
        ));
    }
    Ok(())
}

// Call only for a new clone payload inside its verified private directory. The
// caller must perform inspect_security after its remaining normalization and
// before publication; that fused observation is the ACL-clear readback.
pub(crate) fn clear_private_clone_acl(fd: BorrowedFd<'_>) -> NativeResult<()> {
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

fn inspect_descriptor(fd: i32, inheritance_target: Option<&str>) -> NativeResult<AclState> {
    let target = match inheritance_target {
        None => None,
        Some("file") => Some(InheritanceTarget::File),
        Some("directory") => Some(InheritanceTarget::Directory),
        Some(_) => {
            return Err(native_error(
                "EINVAL",
                "ACL inheritance target must be file or directory",
            ));
        }
    };
    let retained = retain_descriptor(fd)?;
    match target {
        None => inspect_acl(retained.as_fd()),
        Some(_) => {
            let (_, filesec) = read_descriptor_security(retained.as_fd())?;
            filesec_acl_state(&filesec, target)
        }
    }
}

#[napi(object)]
pub struct DarwinAclFacts {
    pub state: String,
}

#[napi(js_name = "inspectDarwinAcl")]
pub fn inspect_darwin_acl(
    env: Env,
    fd: i32,
    inheritance_target: Option<String>,
) -> Result<DarwinAclFacts> {
    // No worker, callback, or await can outlive the owned duplicate.
    into_napi(
        env,
        inspect_descriptor(fd, inheritance_target.as_deref()).map(|state| DarwinAclFacts {
            state: state.as_str().to_owned(),
        }),
    )
}

#[cfg(test)]
#[path = "darwin_security_tests.rs"]
mod tests;
