use std::ffi::{CStr, c_char, c_void};
use std::io::{Read, Write};
use std::mem::{MaybeUninit, size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS,
    ERROR_CALL_NOT_IMPLEMENTED, ERROR_DISK_FULL, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND,
    ERROR_HANDLE_DISK_FULL, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_LOCK_VIOLATION,
    ERROR_NOT_SUPPORTED, ERROR_NO_MORE_FILES, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
    GENERIC_READ, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    FILE_DISPOSITION_INFO_EX, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_BOTH_DIR_INFO,
    FILE_ID_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo,
    FileDispositionInfoEx, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, FileIdInfo,
    GetFileInformationByHandle, GetFileInformationByHandleEx, ReOpenFile,
    SetFileInformationByHandle,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::{
    ExactFileIdentity, FileIdentity, NativeResult, RENAME_SOURCE_IDENTITY_MISMATCH, native_error,
};

const O_WRONLY: i32 = 0x0001;
const O_RDWR: i32 = 0x0002;
const O_CREAT: i32 = 0x0100;
const O_TRUNC: i32 = 0x0200;
const O_EXCL: i32 = 0x0400;

const DELETE_ACCESS: u32 = 0x0001_0000;
const READ_CONTROL: u32 = 0x0002_0000;
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_OPEN_IF: u32 = 3;
const FILE_OVERWRITE: u32 = 4;
const FILE_OVERWRITE_IF: u32 = 5;
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
const OBJ_DONT_REPARSE: u32 = 0x0000_1000;
const FILE_RENAME_FLAG_REPLACE_IF_EXISTS: u32 = 0x0000_0001;
const FILE_RENAME_FLAG_POSIX_SEMANTICS: u32 = 0x0000_0002;
const FILE_LINK_INFORMATION_CLASS: i32 = 11;
const FILE_RENAME_INFORMATION_EX_CLASS: i32 = 65;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *mut ObjectAttributes,
        io_status_block: *mut IO_STATUS_BLOCK,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IO_STATUS_BLOCK,
        file_information: *const c_void,
        length: u32,
        file_information_class: i32,
    ) -> i32;
    fn NtReadFile(
        file_handle: HANDLE,
        event: HANDLE,
        apc_routine: *const c_void,
        apc_context: *const c_void,
        io_status_block: *mut IO_STATUS_BLOCK,
        buffer: *mut c_void,
        length: u32,
        byte_offset: *const i64,
        key: *const u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

pub(crate) struct OwnedHandle(pub(crate) HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: this wrapper uniquely owns the handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

impl OwnedHandle {
    fn into_raw(mut self) -> HANDLE {
        let handle = self.0;
        self.0 = null_mut();
        handle
    }
}

type UvGetOsfhandle = unsafe extern "C" fn(i32) -> isize;
type UvOpenOsfhandle = unsafe extern "C" fn(isize) -> i32;
type UvReqSize = unsafe extern "C" fn(i32) -> usize;
type UvFsCallback = unsafe extern "C" fn(*mut c_void);
type UvFsClose = unsafe extern "C" fn(*mut c_void, *mut c_void, i32, Option<UvFsCallback>) -> i32;
type UvFsReqCleanup = unsafe extern "C" fn(*mut c_void);
type UvErrName = unsafe extern "C" fn(i32) -> *const c_char;

const UV_FS: i32 = 6;
const UV_FS_REQUEST_CAPACITY: usize = 4096;

// libuv's Windows request fields are at most 8-byte aligned. Query the host
// size before admitting opens; opaque stack storage keeps closing allocation-free.
#[repr(C, align(16))]
struct UvFsRequest([MaybeUninit<u8>; UV_FS_REQUEST_CAPACITY]);

#[derive(Clone, Copy, Debug)]
struct UvCloseBridge {
    fs_close: UvFsClose,
    fs_req_cleanup: UvFsReqCleanup,
    err_name: UvErrName,
}

impl UvCloseBridge {
    fn from_symbols(
        req_size: Option<UvReqSize>,
        fs_close: Option<UvFsClose>,
        fs_req_cleanup: Option<UvFsReqCleanup>,
        err_name: Option<UvErrName>,
    ) -> Option<Self> {
        let bridge = Self {
            fs_close: fs_close?,
            fs_req_cleanup: fs_req_cleanup?,
            err_name: err_name?,
        };
        // SAFETY: UV_FS is the stable uv_req_type discriminant, not uv_fs_type.
        let request_size = unsafe { req_size?(UV_FS) };
        (request_size > 0 && request_size <= UV_FS_REQUEST_CAPACITY).then_some(bridge)
    }

    fn close_owned_fd(self, fd: i32) -> NativeResult<()> {
        if fd < 0 {
            return Err(native_error("EBADF", "invalid native-owned file descriptor"));
        }
        let mut request = UvFsRequest([MaybeUninit::uninit(); UV_FS_REQUEST_CAPACITY]);
        let request = request.0.as_mut_ptr().cast();
        // SAFETY: admission verified this storage fits the host's uv_fs_t.
        // A null callback selects synchronous close; it initializes the request.
        let result = unsafe { (self.fs_close)(null_mut(), request, fd, None) };
        // SAFETY: even a failed synchronous close leaves a request for cleanup.
        unsafe { (self.fs_req_cleanup)(request) };
        if result >= 0 {
            return Ok(());
        }
        // Never retry: the host may have consumed its descriptor before failing.
        let name = unsafe { (self.err_name)(result) };
        let code = if name.is_null() {
            "EIO".into()
        } else {
            // SAFETY: uv_err_name returns a libuv-owned NUL-terminated string.
            unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned()
        };
        Err(native_error(
            code,
            format!("close native-owned file descriptor failed with libuv error {result}"),
        ))
    }
}

#[derive(Clone, Copy, Debug)]
struct UvBridge {
    get_osfhandle: UvGetOsfhandle,
    open_osfhandle: UvOpenOsfhandle,
    close: Option<UvCloseBridge>,
}

impl UvBridge {
    fn from_symbols(
        get_osfhandle: Option<UvGetOsfhandle>,
        open_osfhandle: Option<UvOpenOsfhandle>,
        close: Option<UvCloseBridge>,
    ) -> Option<Self> {
        Some(Self {
            get_osfhandle: get_osfhandle?,
            open_osfhandle: open_osfhandle?,
            close,
        })
    }

    fn require_close(self) -> NativeResult<UvCloseBridge> {
        self.close.ok_or_else(|| native_error(
            "ENOTSUP",
            "runtime libuv descriptor close bridge is unavailable",
        ))
    }
}

fn require_uv_bridge(bridge: Option<UvBridge>) -> NativeResult<UvBridge> {
    bridge.ok_or_else(|| native_error(
        "ENOTSUP",
        "runtime libuv descriptor bridge is unavailable",
    ))
}

fn uv_bridge() -> NativeResult<UvBridge> {
    static BRIDGE: OnceLock<Option<UvBridge>> = OnceLock::new();
    require_uv_bridge(*BRIDGE.get_or_init(|| {
        // N-API filesystem descriptors belong to the host runtime's libuv
        // table, not this add-on's CRT. The bridge must come from that same
        // executable; searching other modules would mix descriptor tables.
        let runtime = unsafe { GetModuleHandleW(null()) };
        if runtime.is_null() {
            return None;
        }
        let get_osfhandle = unsafe {
            GetProcAddress(runtime, c"uv_get_osfhandle".as_ptr().cast())
        }?;
        let open_osfhandle = unsafe {
            GetProcAddress(runtime, c"uv_open_osfhandle".as_ptr().cast())
        }?;
        // SAFETY: these are libuv's public C signatures from this same runtime.
        let close = unsafe {
            UvCloseBridge::from_symbols(
                GetProcAddress(runtime, c"uv_req_size".as_ptr().cast())
                    .map(|symbol| std::mem::transmute::<_, UvReqSize>(symbol)),
                GetProcAddress(runtime, c"uv_fs_close".as_ptr().cast())
                    .map(|symbol| std::mem::transmute::<_, UvFsClose>(symbol)),
                GetProcAddress(runtime, c"uv_fs_req_cleanup".as_ptr().cast())
                    .map(|symbol| std::mem::transmute::<_, UvFsReqCleanup>(symbol)),
                GetProcAddress(runtime, c"uv_err_name".as_ptr().cast())
                    .map(|symbol| std::mem::transmute::<_, UvErrName>(symbol)),
            )
        };
        // SAFETY: libuv exports these symbols with the documented
        // `intptr_t uv_get_osfhandle(int)` and
        // `int uv_open_osfhandle(intptr_t)` signatures.
        UvBridge::from_symbols(
            Some(unsafe { std::mem::transmute::<_, UvGetOsfhandle>(get_osfhandle) }),
            Some(unsafe { std::mem::transmute::<_, UvOpenOsfhandle>(open_osfhandle) }),
            close,
        )
    }))
}

fn runtime_handle_from_fd(fd: i32, bridge: UvBridge) -> NativeResult<HANDLE> {
    if fd < 0 {
        return Err(native_error("EBADF", "invalid runtime file descriptor"));
    }
    let handle = unsafe { (bridge.get_osfhandle)(fd) };
    if handle == -1 || handle == 0 {
        return Err(native_error("EBADF", "invalid runtime file descriptor"));
    }
    Ok(handle as HANDLE)
}

pub(crate) fn root_handle(fd: i32) -> NativeResult<HANDLE> {
    runtime_handle_from_fd(fd, uv_bridge()?)
}

fn runtime_fd_for_handle(handle: HANDLE, bridge: UvBridge) -> NativeResult<i32> {
    bridge.require_close()?;
    let fd = unsafe { (bridge.open_osfhandle)(handle as isize) };
    if fd < 0 {
        return Err(native_error(
            "EIO",
            format!("convert Windows handle through libuv: {fd}"),
        ));
    }
    Ok(fd)
}

fn runtime_fd_from_handle_with_bridge(
    handle: OwnedHandle,
    bridge: UvBridge,
) -> NativeResult<i32> {
    let fd = runtime_fd_for_handle(handle.0, bridge)?;
    // libuv owns the HANDLE after a successful conversion.
    let _ = handle.into_raw();
    Ok(fd)
}

pub fn close_owned_fd(fd: i32) -> NativeResult<()> {
    uv_bridge()?.require_close()?.close_owned_fd(fd)
}

fn wide_relative(path: &str) -> NativeResult<Vec<u16>> {
    let normalized = path.replace('/', "\\");
    let wide: Vec<u16> = std::ffi::OsStr::new(&normalized).encode_wide().collect();
    if wide.len() > (u16::MAX as usize / 2) {
        return Err(native_error("ENAMETOOLONG", "relative path is too long"));
    }
    Ok(wide)
}

pub(crate) fn win_error(code: u32, operation: &str) -> napi::Error<String> {
    let typed = match code {
        ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS => "EEXIST",
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "ENOENT",
        ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => "ENOSPC",
        ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION => "EBUSY",
        // Node/libuv reports Windows ERROR_ACCESS_DENIED from filesystem opens
        // as EPERM. Keep the native path aligned so callers can apply the same
        // operation-specific policy after adding their own path provenance.
        ERROR_ACCESS_DENIED => "EPERM",
        _ => "EIO",
    };
    native_error(
        typed,
        format!("{operation} failed with Windows error {code}"),
    )
}

fn nt_error(status: i32, operation: &str) -> napi::Error<String> {
    // SAFETY: converting an NTSTATUS does not dereference application memory.
    win_error(unsafe { RtlNtStatusToDosError(status) }, operation)
}

fn rename_win_error(code: u32, operation: &str) -> napi::Error<String> {
    let typed = match code {
        ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED | ERROR_CALL_NOT_IMPLEMENTED => "ENOTSUP",
        ERROR_INVALID_PARAMETER => "EINVAL",
        _ => return win_error(code, operation),
    };
    native_error(
        typed,
        format!("{operation} failed with Windows error {code}"),
    )
}

fn rename_nt_error(status: i32, operation: &str) -> napi::Error<String> {
    // SAFETY: converting an NTSTATUS does not dereference application memory.
    rename_win_error(unsafe { RtlNtStatusToDosError(status) }, operation)
}

fn handle_attribute_tag_information(
    handle: HANDLE,
    operation: &str,
) -> NativeResult<FILE_ATTRIBUTE_TAG_INFO> {
    // SAFETY: info is a valid output buffer for the supplied class.
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        // SAFETY: GetLastError has no memory safety preconditions.
        return Err(win_error(unsafe { GetLastError() }, operation));
    }
    Ok(info)
}

pub(crate) fn handle_is_reparse(handle: HANDLE) -> NativeResult<bool> {
    Ok(
        handle_attribute_tag_information(handle, "inspect opened path")?.FileAttributes
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0,
    )
}

fn assert_not_reparse(handle: HANDLE) -> NativeResult<()> {
    if handle_is_reparse(handle)? {
        return Err(native_error(
            "ELOOP",
            "reparse points are not allowed beneath root",
        ));
    }
    Ok(())
}

pub(crate) enum ReparsePolicy {
    Reject,
    AllowLeaf,
}

fn nt_open_relative(
    root: HANDLE,
    path: &str,
    desired_access: u32,
    disposition: u32,
    options: u32,
) -> NativeResult<OwnedHandle> {
    nt_open_relative_with_policy(
        root,
        path,
        desired_access,
        disposition,
        options,
        ReparsePolicy::Reject,
    )
}

pub(crate) fn nt_open_relative_with_policy(
    root: HANDLE,
    path: &str,
    desired_access: u32,
    disposition: u32,
    options: u32,
    reparse_policy: ReparsePolicy,
) -> NativeResult<OwnedHandle> {
    nt_open_relative_with_sharing(
        root, path, desired_access, disposition, options, reparse_policy,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )
}

pub(crate) fn nt_open_relative_with_sharing(
    root: HANDLE,
    path: &str,
    desired_access: u32,
    disposition: u32,
    options: u32,
    reparse_policy: ReparsePolicy,
    share_access: u32,
) -> NativeResult<OwnedHandle> {
    nt_open_relative_with_security_descriptor(
        root,
        path,
        desired_access,
        disposition,
        options,
        reparse_policy,
        share_access,
        null_mut(),
        true,
    )
}

// Keep the NtCreateFile inputs explicit at this shared native boundary.
#[allow(clippy::too_many_arguments)]
fn nt_open_relative_with_security_descriptor(
    root: HANDLE,
    path: &str,
    desired_access: u32,
    disposition: u32,
    options: u32,
    reparse_policy: ReparsePolicy,
    share_access: u32,
    security_descriptor: *mut c_void,
    post_open_reparse_check: bool,
) -> NativeResult<OwnedHandle> {
    if !security_descriptor.is_null() && disposition != FILE_CREATE {
        return Err(native_error(
            "EINVAL",
            "a security descriptor is allowed only for exclusive creation",
        ));
    }
    if !post_open_reparse_check
        && (security_descriptor.is_null() || disposition != FILE_CREATE)
    {
        return Err(native_error(
            "EINVAL",
            "only secured exclusive creation may defer the first handle query",
        ));
    }
    if matches!(reparse_policy, ReparsePolicy::AllowLeaf) {
        crate::validate_relative_path(path, false)?;
        if path.contains(['/', '\\']) {
            return Err(native_error("EINVAL", "reparse leaf open requires a direct child"));
        }
    }
    let mut name = wide_relative(path)?;
    let mut unicode = UnicodeString {
        length: (name.len() * 2) as u16,
        maximum_length: (name.len() * 2) as u16,
        buffer: name.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: root,
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE | match reparse_policy {
            ReparsePolicy::Reject => OBJ_DONT_REPARSE,
            // Validated direct child: no intermediate components can reparse.
            ReparsePolicy::AllowLeaf => 0,
        },
        security_descriptor,
        security_quality_of_service: null_mut(),
    };
    // SAFETY: all pointers reference initialized, call-scoped storage.
    let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
    let mut handle: HANDLE = null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access | FILE_READ_ATTRIBUTES | SYNCHRONIZE_ACCESS,
            &mut attributes,
            &mut io,
            null(),
            0,
            share_access,
            disposition,
            // FILE_OPEN_REPARSE_POINT opens the final entry itself without reparsing.
            options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(nt_error(status, "open path relative to root handle"));
    }
    let owned = OwnedHandle(handle);
    if post_open_reparse_check && matches!(reparse_policy, ReparsePolicy::Reject) {
        assert_not_reparse(owned.0)?;
    }
    Ok(owned)
}

pub(crate) fn nt_create_directory_relative(
    root: HANDLE,
    name: &str,
    security_descriptor: *mut c_void,
) -> NativeResult<OwnedHandle> {
    crate::validate_relative_path(name, false)?;
    if name.contains(['/', '\\']) || security_descriptor.is_null() {
        return Err(native_error(
            "EINVAL",
            "private directory creation requires a direct child and security descriptor",
        ));
    }
    nt_open_relative_with_security_descriptor(
        root,
        name,
        DELETE_ACCESS | READ_CONTROL | FILE_WRITE_ATTRIBUTES,
        FILE_CREATE,
        FILE_DIRECTORY_FILE,
        ReparsePolicy::Reject,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        security_descriptor,
        // Exclusive creation must return the exact handle before any fallible query.
        false,
    )
}

fn access_from_flags(flags: i32) -> u32 {
    let mut access = FILE_READ_ATTRIBUTES;
    match flags & 3 {
        O_WRONLY => access |= FILE_GENERIC_WRITE,
        O_RDWR => access |= FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        _ => access |= FILE_GENERIC_READ,
    }
    access
}

fn disposition_from_flags(flags: i32) -> u32 {
    match (
        flags & O_CREAT != 0,
        flags & O_EXCL != 0,
        flags & O_TRUNC != 0,
    ) {
        (true, true, _) => FILE_CREATE,
        (true, false, true) => FILE_OVERWRITE_IF,
        (true, false, false) => FILE_OPEN_IF,
        (false, _, true) => FILE_OVERWRITE,
        _ => FILE_OPEN,
    }
}

pub fn open_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<i32> {
    let bridge = uv_bridge()?;
    // Require host-owned closure before creating or duplicating any descriptor.
    bridge.require_close()?;
    let root = runtime_handle_from_fd(root_fd, bridge)?;
    if rel_path.is_empty() || rel_path == "." {
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate = null_mut();
        if unsafe {
            DuplicateHandle(
                process,
                root,
                process,
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(win_error(
                unsafe { GetLastError() },
                "duplicate root handle",
            ));
        }
        let duplicate = OwnedHandle(duplicate);
        assert_not_reparse(duplicate.0)?;
        return runtime_fd_from_handle_with_bridge(duplicate, bridge);
    }
    let handle = nt_open_relative(
        root,
        rel_path,
        access_from_flags(flags),
        disposition_from_flags(flags),
        0,
    )?;
    runtime_fd_from_handle_with_bridge(handle, bridge)
}

pub fn mkdir_beneath(root_fd: i32, rel_path: &str, _mode: u32) -> NativeResult<()> {
    if rel_path.is_empty() || rel_path == "." {
        return Ok(());
    }
    let mut owned_parent: Option<OwnedHandle> = None;
    for segment in rel_path
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty() && *segment != ".")
    {
        let parent = owned_parent
            .as_ref()
            .map_or(root_handle(root_fd)?, |handle| handle.0);
        owned_parent = Some(nt_open_relative(
            parent,
            segment,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_OPEN_IF,
            FILE_DIRECTORY_FILE,
        )?);
    }
    Ok(())
}

fn mkdir_child_at_handle(parent: HANDLE, basename: &str) -> NativeResult<bool> {
    crate::validate_child_basename(basename)?;
    match nt_open_relative(
        parent,
        basename,
        FILE_READ_ATTRIBUTES,
        FILE_CREATE,
        FILE_DIRECTORY_FILE,
    ) {
        Ok(created) => {
            drop(created);
            Ok(true)
        }
        Err(error) if error.status == "EEXIST" => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn mkdir_child_beneath(parent_fd: i32, basename: &str, _mode: u32) -> NativeResult<bool> {
    mkdir_child_at_handle(root_handle(parent_fd)?, basename)
}

#[repr(C)]
struct FileNameInfoHeader {
    flags: u32,
    root_directory: HANDLE,
    file_name_length: u32,
}

#[repr(C)]
struct FileLinkInfoHeader {
    replace_if_exists: u8,
    root_directory: HANDLE,
    file_name_length: u32,
}

const FILE_NAME_OFFSET: usize = 20;

fn aligned_name_buffer(byte_len: usize) -> Vec<usize> {
    let word_len = byte_len.div_ceil(size_of::<usize>());
    vec![0_usize; word_len]
}

fn set_rename_information(
    source: HANDLE,
    target_root: HANDLE,
    target_path: &str,
    replace: bool,
    operation: &str,
) -> NativeResult<()> {
    let name = wide_relative(target_path)?;
    let name_bytes = std::mem::size_of_val(name.as_slice());
    let byte_len = (FILE_NAME_OFFSET + name_bytes).max(size_of::<FileNameInfoHeader>());
    let mut buffer = aligned_name_buffer(byte_len);
    // SAFETY: the zeroed usize storage is suitably aligned, the fixed fields
    // end at offset 20 on the supported Windows x64 ABI, and the allocation is
    // large enough for the trailing UTF-16 filename.
    unsafe {
        let header = buffer.as_mut_ptr().cast::<FileNameInfoHeader>();
        (*header).flags = FILE_RENAME_FLAG_POSIX_SEMANTICS
            | if replace {
                FILE_RENAME_FLAG_REPLACE_IF_EXISTS
            } else {
                0
            };
        (*header).root_directory = target_root;
        (*header).file_name_length = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr().cast::<u8>(),
            buffer.as_mut_ptr().cast::<u8>().add(FILE_NAME_OFFSET),
            name_bytes,
        );
    }
    // SAFETY: buffer contains FILE_RENAME_INFORMATION_EX followed by the
    // UTF-16 target name, and io remains valid for the synchronous call.
    let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
    let status = unsafe {
        NtSetInformationFile(
            source,
            &mut io,
            buffer.as_ptr().cast(),
            byte_len as u32,
            FILE_RENAME_INFORMATION_EX_CLASS,
        )
    };
    if status < 0 {
        // The target may exist because this rename was refused, because it was
        // committed before an acknowledgement failed, or because another actor
        // created it. Only the NTSTATUS conversion may classify a collision;
        // a second pathname observation cannot prove an uncommitted outcome.
        return Err(rename_nt_error(status, operation));
    }
    Ok(())
}

fn set_link_information(
    source: HANDLE,
    target_root: HANDLE,
    target_path: &str,
) -> NativeResult<()> {
    let name = wide_relative(target_path)?;
    let name_bytes = std::mem::size_of_val(name.as_slice());
    let byte_len = (FILE_NAME_OFFSET + name_bytes).max(size_of::<FileLinkInfoHeader>());
    let mut buffer = aligned_name_buffer(byte_len);
    // SAFETY: FILE_LINK_INFORMATION uses the same x64 filename offset.
    unsafe {
        let header = buffer.as_mut_ptr().cast::<FileLinkInfoHeader>();
        (*header).replace_if_exists = 0;
        (*header).root_directory = target_root;
        (*header).file_name_length = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr().cast::<u8>(),
            buffer.as_mut_ptr().cast::<u8>().add(FILE_NAME_OFFSET),
            name_bytes,
        );
    }
    // SAFETY: buffer contains FILE_LINK_INFORMATION followed by the UTF-16
    // name, and io remains valid for the synchronous call.
    let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
    let status = unsafe {
        NtSetInformationFile(
            source,
            &mut io,
            buffer.as_ptr().cast(),
            byte_len as u32,
            FILE_LINK_INFORMATION_CLASS,
        )
    };
    if status < 0 {
        return Err(nt_error(status, "create hard link without replacement"));
    }
    Ok(())
}

fn open_source_for_metadata(
    root_fd: i32,
    path: &str,
    extra_access: u32,
) -> NativeResult<OwnedHandle> {
    nt_open_relative(
        root_handle(root_fd)?,
        path,
        FILE_READ_ATTRIBUTES | extra_access,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
    )
}

pub fn link_beneath(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let source = open_source_for_metadata(source_root_fd, source_rel_path, FILE_WRITE_ATTRIBUTES)?;
    set_link_information(source.0, root_handle(target_root_fd)?, target_rel_path)
}

fn open_source_for_rename(root: HANDLE, path: &str) -> NativeResult<OwnedHandle> {
    // Omitting both directory type flags admits files and directories, while
    // nt_open_relative still rejects reparse points and requests delete access.
    nt_open_relative(root, path, FILE_READ_ATTRIBUTES | DELETE_ACCESS, FILE_OPEN, 0)
}

pub fn rename_no_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let source = open_source_for_rename(root_handle(source_root_fd)?, source_rel_path)?;
    set_rename_information(
        source.0,
        root_handle(target_root_fd)?,
        target_rel_path,
        false,
        "rename without replacement",
    )
}

pub fn rename_no_replace_with_identity(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
    expected_source_identity: ExactFileIdentity,
) -> NativeResult<()> {
    let source = open_source_for_rename(root_handle(source_root_fd)?, source_rel_path)?;
    let (dev, ino, _) = handle_identity(source.0)?;
    if u64::from(dev) != expected_source_identity.dev || ino != expected_source_identity.ino {
        // This internal-only code is emitted before the mutating syscall, so
        // retained replacement can distinguish a definitely uncommitted fence
        // rejection from an arbitrary path-mismatch-shaped native failure.
        return Err(native_error(
            RENAME_SOURCE_IDENTITY_MISMATCH,
            "rename source identity changed before mutation",
        ));
    }
    set_rename_information(
        source.0,
        root_handle(target_root_fd)?,
        target_rel_path,
        false,
        "rename without replacement",
    )
}

pub fn rename_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let source = open_source_for_rename(root_handle(source_root_fd)?, source_rel_path)?;
    set_rename_information(
        source.0,
        root_handle(target_root_fd)?,
        target_rel_path,
        true,
        "rename with replacement",
    )
}

pub(crate) fn handle_identity(handle: HANDLE) -> NativeResult<(u32, u64, bool)> {
    handle_identity_and_size(handle).map(|(identity, _)| identity)
}

fn directory_observation_identity(
    info: &BY_HANDLE_FILE_INFORMATION,
) -> NativeResult<(u32, u64)> {
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(native_error("ELOOP", "observed directory is a reparse point"));
    }
    let (dev, ino, is_directory) = identity_from_handle_information(info);
    if !is_directory {
        return Err(native_error("ENOTDIR", "observed path is not a directory"));
    }
    Ok((dev, ino))
}

pub(crate) fn observe_directory_identity(handle: HANDLE) -> NativeResult<(u32, u64)> {
    // The complete handle information already includes the reparse/directory
    // attributes. Keep those facts with the exact identity in one observation.
    directory_observation_identity(&guarded_handle_information(handle)?)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct HandleFileIdentity {
    volume_serial_number: u64,
    file_id: [u8; 16],
}

fn file_identity_error(code: u32) -> napi::Error<String> {
    if matches!(
        code,
        ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED | ERROR_INVALID_PARAMETER
    ) {
        native_error(
            "ENOTSUP",
            format!(
                "stable 128-bit Windows file identity is unavailable (Windows error {code})"
            ),
        )
    } else {
        win_error(code, "inspect stable 128-bit Windows file identity")
    }
}

pub(crate) fn handle_file_identity(handle: HANDLE) -> NativeResult<HandleFileIdentity> {
    // FILE_ID_INFO is available in the supported SDK; filesystems that cannot
    // supply it fail closed rather than falling back to a narrower identity.
    let mut info: FILE_ID_INFO = unsafe { zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(file_identity_error(unsafe { GetLastError() }));
    }
    Ok(HandleFileIdentity {
        volume_serial_number: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    })
}

fn guarded_handle_information(handle: HANDLE) -> NativeResult<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: info is a valid output buffer for this API.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(win_error(
            unsafe { GetLastError() },
            "inspect owned directory identity",
        ));
    }
    Ok(info)
}

fn identity_from_handle_information(
    info: &BY_HANDLE_FILE_INFORMATION,
) -> (u32, u64, bool) {
    (
        info.dwVolumeSerialNumber,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
    )
}

pub(crate) fn handle_attributes(handle: HANDLE) -> NativeResult<u32> {
    // Keep attribute-only guards independent from the larger legacy identity
    // structure; stable identity remains a separate FileIdInfo query.
    Ok(
        handle_attribute_tag_information(handle, "inspect owned directory identity")?
            .FileAttributes,
    )
}

pub(crate) fn handle_identity_and_size(
    handle: HANDLE,
) -> NativeResult<((u32, u64, bool), u64)> {
    let info = guarded_handle_information(handle)?;
    Ok((
        identity_from_handle_information(&info),
        ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64,
    ))
}

pub fn owned_tree_removal_available(parent_fd: i32) -> bool {
    parent_fd >= 0
        && root_handle(parent_fd)
            .and_then(|handle| {
                assert_not_reparse(handle)?;
                handle_identity(handle)
            })
            .is_ok_and(|identity| identity.2)
}

fn same_handle_identity(left: HANDLE, right: HANDLE) -> NativeResult<bool> {
    let left = handle_identity(left)?;
    let right = handle_identity(right)?;
    Ok(left.2 && right.2 && left.0 == right.0 && left.1 == right.1)
}

pub(crate) fn list_directory_entries(directory: HANDLE) -> NativeResult<Vec<(String, u32, u64)>> {
    let mut entries = Vec::new();
    let mut restart = true;
    let mut storage = vec![0_usize; (64_usize * 1024).div_ceil(size_of::<usize>())];
    loop {
        let class = if restart {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        let ok = unsafe {
            GetFileInformationByHandleEx(
                directory,
                class,
                storage.as_mut_ptr().cast(),
                (storage.len() * size_of::<usize>()) as u32,
            )
        };
        if ok == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(win_error(error, "enumerate owned directory"));
        }
        restart = false;
        let bytes = storage.len() * size_of::<usize>();
        let mut offset = 0_usize;
        loop {
            if offset + size_of::<FILE_ID_BOTH_DIR_INFO>() > bytes {
                return Err(native_error("EIO", "invalid owned directory entry buffer"));
            }
            let info = unsafe {
                &*storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFO>()
            };
            let name_bytes = info.FileNameLength as usize;
            let name_offset = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            if name_bytes % 2 != 0 || offset + name_offset + name_bytes > bytes {
                return Err(native_error("EIO", "invalid owned directory entry name"));
            }
            let name = unsafe {
                std::slice::from_raw_parts(
                    storage
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset + name_offset)
                        .cast::<u16>(),
                    name_bytes / 2,
                )
            };
            let name = String::from_utf16(name)
                .map_err(|_| native_error("EINVAL", "owned directory entry is not valid UTF-16"))?;
            if name != "." && name != ".." {
                entries.push((name, info.FileAttributes, info.FileId as u64));
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            offset = offset
                .checked_add(info.NextEntryOffset as usize)
                .ok_or_else(|| native_error("EIO", "owned directory entry offset overflow"))?;
        }
    }
    Ok(entries)
}

pub(crate) fn mark_handle_for_deletion(handle: HANDLE) -> NativeResult<()> {
    let info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let ok = unsafe {
        SetFileInformationByHandle(
            handle,
            FileDispositionInfoEx,
            (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if ok == 0 {
        return Err(win_error(
            unsafe { GetLastError() },
            "remove owned tree handle",
        ));
    }
    Ok(())
}

fn remove_directory_handle_with_hook(
    directory: HANDLE,
    before_child_open: &mut impl FnMut(&str),
) -> NativeResult<()> {
    let parent_volume = handle_identity(directory)?.0;
    for (name, attributes, file_id) in list_directory_entries(directory)? {
        let is_reparse = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        let traverse = is_directory && !is_reparse;
        before_child_open(&name);
        let child = nt_open_relative_with_policy(
            directory,
            &name,
            DELETE_ACCESS
                | FILE_WRITE_ATTRIBUTES
                | if traverse { FILE_LIST_DIRECTORY } else { 0 },
            FILE_OPEN,
            // Admit either type so substitutions reach the identity check.
            0,
            ReparsePolicy::AllowLeaf,
        )?;
        let opened = handle_identity(child.0)?;
        let opened_reparse = handle_is_reparse(child.0)?;
        if opened.0 != parent_volume || opened.1 != file_id || opened.2 != is_directory
            || opened_reparse != is_reparse
        {
            return Err(native_error(
                "path-mismatch",
                "owned tree child changed while opening",
            ));
        }
        if traverse {
            remove_directory_handle_with_hook(child.0, before_child_open)?;
        }
        mark_handle_for_deletion(child.0)?;
    }
    Ok(())
}

pub(crate) fn remove_directory_handle(directory: HANDLE) -> NativeResult<()> {
    remove_directory_handle_with_hook(directory, &mut |_| {})
}

fn remove_owned_tree_handles_with_hook(
    parent: HANDLE,
    name: &str,
    expected: HANDLE,
    before_root_delete: impl FnOnce(),
) -> NativeResult<String> {
    let owned = match nt_open_relative_with_policy(
        parent,
        name,
        DELETE_ACCESS | FILE_WRITE_ATTRIBUTES | FILE_LIST_DIRECTORY,
        FILE_OPEN,
        // Classify a substituted quarantine entry without following or constraining its type.
        0,
        ReparsePolicy::AllowLeaf,
    ) {
        Ok(owned) => owned,
        Err(error) if error.status == "ENOENT" => return Ok("preserved".to_owned()),
        Err(error) => return Err(error),
    };
    if handle_is_reparse(owned.0)? || !same_handle_identity(expected, owned.0)? {
        return Ok("preserved".to_owned());
    }
    remove_directory_handle(owned.0)?;
    before_root_delete();
    mark_handle_for_deletion(owned.0)?;
    Ok("removed".to_owned())
}

fn remove_owned_tree_with_hook(
    parent_fd: i32,
    name: &str,
    directory_fd: i32,
    before_root_delete: impl FnOnce(),
) -> NativeResult<String> {
    remove_owned_tree_handles_with_hook(
        root_handle(parent_fd)?,
        name,
        root_handle(directory_fd)?,
        before_root_delete,
    )
}

pub fn remove_owned_tree(
    parent_fd: i32,
    name: &str,
    directory_fd: i32,
) -> NativeResult<String> {
    remove_owned_tree_with_hook(parent_fd, name, directory_fd, || {})
}

pub fn fstat_identity(fd: i32) -> NativeResult<FileIdentity> {
    let handle = root_handle(fd)?;
    assert_not_reparse(handle)?;
    // SAFETY: info is a valid output buffer for this API.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        // SAFETY: GetLastError has no memory safety preconditions.
        return Err(win_error(
            unsafe { GetLastError() },
            "inspect file identity",
        ));
    }
    let is_directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let size = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
    let ino = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Ok(FileIdentity {
        dev: info.dwVolumeSerialNumber as f64,
        ino: ino as f64,
        mode: if is_directory { 0o040000 } else { 0o100000 },
        nlink: info.nNumberOfLinks as f64,
        size: size as f64,
        is_file: !is_directory,
        is_directory,
        is_symbolic_link: false,
    })
}

pub fn write_archive_file<R: Read>(
    root_fd: i32,
    rel_path: &str,
    reader: &mut R,
    expected_size: u64,
    _mode: u32,
) -> NativeResult<()> {
    let handle = nt_open_relative(
        root_handle(root_fd)?,
        rel_path,
        FILE_GENERIC_WRITE,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
    )?;
    // SAFETY: into_raw transfers the uniquely owned HANDLE to File.
    let mut file = unsafe { std::fs::File::from_raw_handle(handle.into_raw()) };
    let copied = std::io::copy(&mut reader.take(expected_size.saturating_add(1)), &mut file)
        .map_err(|error| native_error("EIO", format!("write archive entry: {error}")))?;
    if copied != expected_size {
        return Err(native_error(
            "EINVAL",
            "archive entry size did not match its manifest",
        ));
    }
    file.flush()
        .map_err(|error| native_error("EIO", format!("flush archive entry: {error}")))
}

pub fn chmod_beneath(_root_fd: i32, _rel_path: &str, _mode: u32) -> NativeResult<()> {
    Ok(())
}

pub struct IndependentReader(OwnedHandle);

pub fn open_independent_reader(fd: i32) -> NativeResult<IndependentReader> {
    open_independent_reader_handle(root_handle(fd)?)
}

pub(crate) fn open_independent_reader_handle(handle: HANDLE) -> NativeResult<IndependentReader> {
    let handle = unsafe {
        ReOpenFile(
            handle,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(win_error(
            unsafe { GetLastError() },
            "reopen file for position-independent read",
        ));
    }
    Ok(IndependentReader(OwnedHandle(handle)))
}

pub fn read_at(reader: &IndependentReader, buffer: &mut [u8], offset: u64) -> NativeResult<usize> {
    const STATUS_END_OF_FILE: i32 = 0xC000_0011_u32 as i32;
    let offset = i64::try_from(offset)
        .map_err(|_| native_error("EINVAL", "read offset exceeds Windows range"))?;
    let length = u32::try_from(buffer.len())
        .map_err(|_| native_error("EINVAL", "read buffer exceeds Windows range"))?;
    let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
    // SAFETY: the handle is valid, buffer is writable for length bytes, and
    // the synchronous handle keeps all stack arguments live until completion.
    let status = unsafe {
        NtReadFile(
            reader.0.0,
            null_mut(),
            null(),
            null(),
            &mut io,
            buffer.as_mut_ptr().cast(),
            length,
            &offset,
            null(),
        )
    };
    if status == STATUS_END_OF_FILE {
        return Ok(0);
    }
    if status < 0 {
        return Err(nt_error(status, "read file at offset"));
    }
    Ok(io.Information)
}

pub fn clone_file_exclusive(
    _source_fd: i32,
    _target_root_fd: i32,
    _target_rel_path: &str,
) -> NativeResult<i32> {
    Err(native_error(
        "ENOTSUP",
        "file cloning is not available on Windows",
    ))
}

pub fn copy_file_range_exclusive(
    _source_fd: i32,
    _target_root_fd: i32,
    _target_rel_path: &str,
) -> NativeResult<(i32, u64)> {
    Err(native_error(
        "ENOTSUP",
        "copy_file_range is not available on Windows",
    ))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, IntoRawHandle};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn directory_observation_retains_exact_identity_and_unknown_values() {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        info.dwFileAttributes = FILE_ATTRIBUTE_DIRECTORY;
        info.dwVolumeSerialNumber = 0x11223344;
        info.nFileIndexHigh = 0x12345678;
        info.nFileIndexLow = 0xabcdef01;
        assert_eq!(
            directory_observation_identity(&info).unwrap(),
            (0x11223344, 0x12345678abcdef01),
        );
        // JavaScript still owns the bounded retry for opaque Windows IDs.
        info.dwVolumeSerialNumber = 0;
        info.nFileIndexHigh = 0;
        info.nFileIndexLow = 0;
        assert_eq!(directory_observation_identity(&info).unwrap(), (0, 0));
    }

    #[test]
    fn directory_observation_rejects_reparse_points_and_regular_files() {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        for attributes in [FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY] {
            info.dwFileAttributes = attributes;
            assert_eq!(directory_observation_identity(&info).unwrap_err().status, "ELOOP");
        }
        info.dwFileAttributes = 0;
        assert_eq!(directory_observation_identity(&info).unwrap_err().status, "ENOTDIR");
    }

    unsafe extern "C" fn test_get_osfhandle(fd: i32) -> isize {
        0x1000 + fd as isize
    }

    unsafe extern "C" fn test_open_osfhandle(handle: isize) -> i32 {
        i32::try_from(handle - 0x1000).unwrap_or(-1)
    }

    unsafe extern "C" fn test_null_osfhandle(_fd: i32) -> isize {
        0
    }

    unsafe extern "C" fn test_open_osfhandle_failure(_handle: isize) -> i32 {
        -1
    }

    unsafe extern "C" fn test_open_osfhandle_success(_handle: isize) -> i32 {
        73
    }

    thread_local! {
        static CLOSE_EVENTS: RefCell<Vec<(&'static str, i32)>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "C" fn test_req_size(kind: i32) -> usize {
        assert_eq!(kind, UV_FS);
        256
    }

    unsafe extern "C" fn test_empty_req_size(_kind: i32) -> usize {
        0
    }

    unsafe extern "C" fn test_oversized_req_size(_kind: i32) -> usize {
        UV_FS_REQUEST_CAPACITY + 1
    }

    unsafe extern "C" fn test_fs_close(
        event_loop: *mut c_void,
        request: *mut c_void,
        fd: i32,
        callback: Option<UvFsCallback>,
    ) -> i32 {
        assert!(event_loop.is_null());
        assert!(callback.is_none());
        assert_eq!(request as usize % 16, 0);
        // SAFETY: the close wrapper supplies sufficient aligned request storage.
        unsafe { request.cast::<i32>().write(fd) };
        CLOSE_EVENTS.with(|events| events.borrow_mut().push(("close", fd)));
        if fd == 74 { -4083 } else { 0 }
    }

    unsafe extern "C" fn test_fs_req_cleanup(request: *mut c_void) {
        // SAFETY: test_fs_close initialized the request's first field.
        let fd = unsafe { request.cast::<i32>().read() };
        CLOSE_EVENTS.with(|events| events.borrow_mut().push(("cleanup", fd)));
    }

    unsafe extern "C" fn test_err_name(error: i32) -> *const c_char {
        assert_eq!(error, -4083);
        c"EBADF".as_ptr()
    }

    fn test_close_bridge() -> Option<UvCloseBridge> {
        UvCloseBridge::from_symbols(
            Some(test_req_size),
            Some(test_fs_close),
            Some(test_fs_req_cleanup),
            Some(test_err_name),
        )
    }

    #[test]
    fn runtime_close_requires_all_host_exports_and_supported_request_storage() {
        let size = Some(test_req_size as UvReqSize);
        let close = Some(test_fs_close as UvFsClose);
        let cleanup = Some(test_fs_req_cleanup as UvFsReqCleanup);
        let name = Some(test_err_name as UvErrName);
        for (req_size, fs_close, fs_cleanup, err_name) in [
            (None, close, cleanup, name),
            (size, None, cleanup, name),
            (size, close, None, name),
            (size, close, cleanup, None),
            (Some(test_empty_req_size as UvReqSize), close, cleanup, name),
            (Some(test_oversized_req_size as UvReqSize), close, cleanup, name),
        ] {
            assert!(UvCloseBridge::from_symbols(req_size, fs_close, fs_cleanup, err_name).is_none());
        }
        assert!(test_close_bridge().is_some());
    }

    #[test]
    fn runtime_close_consumes_once_cleans_up_and_preserves_host_errors() {
        CLOSE_EVENTS.with(|events| events.borrow_mut().clear());
        let bridge = test_close_bridge().unwrap();
        bridge.close_owned_fd(73).unwrap();
        let error = bridge.close_owned_fd(74).unwrap_err();
        assert_eq!(error.status, "EBADF");
        assert!(error.reason.contains("-4083"));
        assert_eq!(bridge.close_owned_fd(-1).unwrap_err().status, "EBADF");
        CLOSE_EVENTS.with(|events| assert_eq!(
            *events.borrow(),
            [("close", 73), ("cleanup", 73), ("close", 74), ("cleanup", 74)],
        ));
    }

    #[test]
    fn runtime_missing_close_bridge_still_borrows_but_never_exports_a_descriptor() {
        let bridge = UvBridge::from_symbols(
            Some(test_get_osfhandle),
            Some(test_open_osfhandle_success),
            None,
        ).unwrap();
        assert_eq!(runtime_handle_from_fd(37, bridge).unwrap() as usize, 0x1025);
        assert_eq!(
            runtime_fd_for_handle(0x1025 as HANDLE, bridge).unwrap_err().status,
            "ENOTSUP",
        );
    }

    #[test]
    fn runtime_descriptor_bridge_requires_both_host_exports() {
        for bridge in [
            UvBridge::from_symbols(None, None, test_close_bridge()),
            UvBridge::from_symbols(Some(test_get_osfhandle), None, test_close_bridge()),
            UvBridge::from_symbols(None, Some(test_open_osfhandle), test_close_bridge()),
        ] {
            let error = require_uv_bridge(bridge).unwrap_err();
            assert_eq!(error.status, "ENOTSUP");
        }
        assert!(UvBridge::from_symbols(
            Some(test_get_osfhandle),
            Some(test_open_osfhandle),
            test_close_bridge(),
        ).is_some());
    }

    #[test]
    fn runtime_descriptor_bridge_never_guesses_a_raw_handle_namespace() {
        let bridge = UvBridge::from_symbols(
            Some(test_get_osfhandle),
            Some(test_open_osfhandle),
            test_close_bridge(),
        ).unwrap();
        let fd = 37;
        let handle = runtime_handle_from_fd(fd, bridge).unwrap();
        assert_eq!(handle as usize, 0x1000 + fd as usize);
        assert_ne!(handle as usize, fd as usize);
        assert_eq!(runtime_fd_for_handle(handle, bridge).unwrap(), fd);
        assert_eq!(runtime_handle_from_fd(-1, bridge).unwrap_err().status, "EBADF");
        let null_bridge = UvBridge::from_symbols(
            Some(test_null_osfhandle),
            Some(test_open_osfhandle),
            test_close_bridge(),
        ).unwrap();
        assert_eq!(
            runtime_handle_from_fd(fd, null_bridge).unwrap_err().status,
            "EBADF",
        );
        assert_eq!(
            runtime_fd_for_handle(INVALID_HANDLE_VALUE, bridge)
                .unwrap_err()
                .status,
            "EIO",
        );
    }

    #[test]
    fn runtime_descriptor_bridge_transfers_handle_ownership_only_on_success() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fs-safe-runtime-fd-ownership-{}-{nonce}",
            std::process::id(),
        ));
        fs::write(&path, b"owned").unwrap();

        let open_exclusive = || OpenOptions::new().read(true).share_mode(0).open(&path);
        let failed_handle = open_exclusive().unwrap().into_raw_handle();
        let failure_bridge = UvBridge::from_symbols(
            Some(test_get_osfhandle),
            Some(test_open_osfhandle_failure),
            test_close_bridge(),
        ).unwrap();
        assert_eq!(
            runtime_fd_from_handle_with_bridge(OwnedHandle(failed_handle), failure_bridge)
                .unwrap_err()
                .status,
            "EIO",
        );
        drop(open_exclusive().unwrap());

        let transferred_handle = open_exclusive().unwrap().into_raw_handle();
        let success_bridge = UvBridge::from_symbols(
            Some(test_get_osfhandle),
            Some(test_open_osfhandle_success),
            test_close_bridge(),
        ).unwrap();
        assert_eq!(
            runtime_fd_from_handle_with_bridge(OwnedHandle(transferred_handle), success_bridge)
                .unwrap(),
            73,
        );
        assert_eq!(
            open_exclusive().unwrap_err().raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32),
        );
        assert_ne!(unsafe { CloseHandle(transferred_handle) }, 0);
        drop(open_exclusive().unwrap());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn directory_enumeration_spans_batches_and_restarts_without_losing_entries() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = base.join(format!("fs-safe-directory-batches-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let owned = fs::canonicalize(&root).unwrap();
        assert_eq!(owned.parent(), Some(base.as_path()));
        let mut expected = BTreeMap::new();
        // Long ordinary names make this exceed a single 64 KiB enumeration batch.
        for index in 0..400 {
            let name = format!("{index:04}-{}", "entry".repeat(16));
            let path = root.join(&name);
            let is_directory = index % 20 == 0;
            if is_directory {
                fs::create_dir(&path).unwrap();
            } else {
                fs::write(&path, [index as u8]).unwrap();
            }
            let handle = OpenOptions::new()
                .read(true)
                .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
                .open(&path)
                .unwrap();
            let identity = handle_identity(handle.as_raw_handle()).unwrap();
            expected.insert(name, (is_directory, identity.1));
        }
        {
            let handle = OpenOptions::new()
                .read(true)
                .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
                .open(&root)
                .unwrap();
            for _ in 0..2 {
                let entries = list_directory_entries(handle.as_raw_handle()).unwrap();
                assert_eq!(entries.len(), expected.len());
                let actual: BTreeMap<_, _> = entries
                    .into_iter()
                    .map(|(name, attributes, id)| {
                        (name, (attributes & FILE_ATTRIBUTE_DIRECTORY != 0, id))
                    })
                    .collect();
                assert_eq!(actual, expected);
            }
        }
        assert_eq!(fs::canonicalize(&root).unwrap(), owned);
        assert_eq!(owned.parent(), Some(base.as_path()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn maps_access_denied_to_node_filesystem_eperm() {
        assert_eq!(win_error(ERROR_ACCESS_DENIED, "test").status, "EPERM");
    }

    #[test]
    fn stable_file_identity_uses_volume_and_all_128_file_id_bits() {
        let identity = HandleFileIdentity {
            volume_serial_number: 7,
            file_id: [0; 16],
        };
        let mut different_high_bit = identity;
        different_high_bit.file_id[15] = 0x80;
        let mut different_volume = identity;
        different_volume.volume_serial_number = 8;
        let mut different_volume_high_bit = identity;
        different_volume_high_bit.volume_serial_number |= 1_u64 << 63;
        assert_ne!(identity, different_high_bit);
        assert_ne!(identity, different_volume);
        assert_ne!(identity, different_volume_high_bit);

        for code in [
            ERROR_INVALID_FUNCTION,
            ERROR_NOT_SUPPORTED,
            ERROR_INVALID_PARAMETER,
        ] {
            let error = file_identity_error(code);
            assert_eq!(error.status, "ENOTSUP");
            assert!(error.reason.contains("128-bit Windows file identity"));
        }
    }

    #[test]
    fn maps_disk_full_and_sharing_failures_to_node_filesystem_errors() {
        for (code, expected) in [
            (ERROR_DISK_FULL, "ENOSPC"),
            (ERROR_HANDLE_DISK_FULL, "ENOSPC"),
            (ERROR_SHARING_VIOLATION, "EBUSY"),
            (ERROR_LOCK_VIOLATION, "EBUSY"),
        ] {
            assert_eq!(
                win_error(code, "copy file").status,
                expected,
                "Windows error {code}"
            );
        }
    }

    #[test]
    fn maps_unsupported_rename_information_to_typed_errors() {
        for (code, expected) in [
            (ERROR_INVALID_FUNCTION, "ENOTSUP"),
            (ERROR_NOT_SUPPORTED, "ENOTSUP"),
            (ERROR_CALL_NOT_IMPLEMENTED, "ENOTSUP"),
            (ERROR_INVALID_PARAMETER, "EINVAL"),
        ] {
            assert_eq!(
                rename_win_error(code, "rename file").status,
                expected,
                "Windows error {code}"
            );
        }
        assert_eq!(
            rename_win_error(ERROR_DISK_FULL, "rename file").status,
            "ENOSPC"
        );
        for (code, expected) in [
            (ERROR_FILE_EXISTS, "EEXIST"),
            (ERROR_ALREADY_EXISTS, "EEXIST"),
            (ERROR_ACCESS_DENIED, "EPERM"),
            (ERROR_SHARING_VIOLATION, "EBUSY"),
        ] {
            assert_eq!(
                rename_win_error(code, "rename file").status,
                expected,
                "Windows error {code} must retain its own rename outcome"
            );
        }
    }

    #[test]
    fn reparse_leaf_open_requires_a_direct_child() {
        for name in ["", ".", "..", "nested/child", "nested\\child"] {
            let result = nt_open_relative_with_policy(
                null_mut(), name, DELETE_ACCESS, FILE_OPEN, 0, ReparsePolicy::AllowLeaf,
            );
            assert_eq!(result.err().unwrap().status, "EINVAL");
        }
    }

    #[test]
    fn owned_tree_cleanup_preserves_a_directory_replaced_by_a_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fs-safe-native-win-owned-type-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/owned"), b"owned").unwrap();
        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&root)
            .unwrap();
        let error = remove_directory_handle_with_hook(
            directory.as_raw_handle() as HANDLE,
            &mut |name| {
                assert_eq!(name, "nested");
                fs::rename(root.join("nested"), root.join("original")).unwrap();
                fs::write(root.join("nested"), b"replacement").unwrap();
            },
        )
        .unwrap_err();
        assert_eq!(error.status, "path-mismatch");
        assert_eq!(fs::read(root.join("nested")).unwrap(), b"replacement");
        assert_eq!(fs::read(root.join("original/owned")).unwrap(), b"owned");
        drop(directory);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_rejects_an_enumerated_child_replacement() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fs-safe-native-win-owned-child-{}-{nonce}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&workspace)
            .unwrap();
        let mut swapped = false;
        let error = remove_directory_handle_with_hook(
            directory.as_raw_handle() as HANDLE,
            &mut |name| {
                if name == "nested" && !swapped {
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
        drop(directory);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_preserves_a_root_replaced_by_a_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fs-safe-native-win-owned-root-type-{}-{nonce}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        let parent = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&root)
            .unwrap();
        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&workspace)
            .unwrap();
        fs::rename(&workspace, root.join("original")).unwrap();
        fs::write(&workspace, b"replacement").unwrap();

        let outcome = remove_owned_tree_handles_with_hook(
            parent.as_raw_handle() as HANDLE,
            "workspace",
            directory.as_raw_handle() as HANDLE,
            || panic!("a substituted root must not reach deletion"),
        )
        .unwrap();
        assert_eq!(outcome, "preserved");
        assert_eq!(fs::read(&workspace).unwrap(), b"replacement");
        assert_eq!(fs::read(root.join("original/nested/owned")).unwrap(), b"owned");
        drop(directory);
        drop(parent);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_tree_cleanup_deletes_the_opened_root_not_a_final_replacement() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fs-safe-native-win-owned-tree-{}-{nonce}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join("nested")).unwrap();
        fs::write(workspace.join("nested/owned"), b"owned").unwrap();
        let parent = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&root)
            .unwrap();
        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&workspace)
            .unwrap();

        let outcome = remove_owned_tree_handles_with_hook(
            parent.as_raw_handle() as HANDLE,
            "workspace",
            directory.as_raw_handle() as HANDLE,
            || {
                fs::rename(&workspace, root.join("original")).unwrap();
                fs::create_dir(&workspace).unwrap();
                fs::create_dir(workspace.join("nested")).unwrap();
                fs::write(workspace.join("nested/keep"), b"replacement").unwrap();
            },
        )
        .unwrap();
        assert_eq!(outcome, "removed");
        drop(directory);
        assert_eq!(fs::read(workspace.join("nested/keep")).unwrap(), b"replacement");
        assert!(!root.join("original").exists());
        drop(parent);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renames_directory_sources_without_replacing_destinations() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .join(format!("fs-safe-native-win-dir-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("source")).unwrap();
        fs::write(root.join("source/owned.txt"), b"owned").unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/keep.txt"), b"keep").unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&root)
            .unwrap();
        let parent_handle = parent.as_raw_handle() as HANDLE;
        let source = open_source_for_rename(parent_handle, "source").unwrap();
        for target in ["target", "empty"] {
            let error =
                set_rename_information(source.0, parent_handle, target, false, "rename directory")
                    .unwrap_err();
            assert_eq!(error.status, "EEXIST");
        }
        assert_eq!(fs::read(root.join("source/owned.txt")).unwrap(), b"owned");
        assert_eq!(fs::read(root.join("target/keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(root.join("empty")).unwrap().count(), 0);
        set_rename_information(source.0, parent_handle, "quarantine", false, "rename directory")
            .unwrap();
        assert!(!root.join("source").exists());
        assert_eq!(fs::read(root.join("quarantine/owned.txt")).unwrap(), b"owned");
        drop(source);
        let quarantined = open_source_for_rename(parent_handle, "quarantine").unwrap();
        set_rename_information(quarantined.0, parent_handle, "renamed", true, "rename directory")
            .unwrap();
        drop(quarantined);
        assert!(!root.join("quarantine").exists());
        assert_eq!(fs::read(root.join("renamed/owned.txt")).unwrap(), b"owned");
        // Hard-link metadata opens must remain file-only.
        assert!(nt_open_relative(
            parent_handle,
            "renamed",
            FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        ).is_err());
        drop(parent);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_reparse_points_and_preserves_existing_rename_target() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("fs-safe-native-win-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("source"), b"source").unwrap();
        fs::write(root.join("target"), b"target").unwrap();
        let root_handle = OpenOptions::new()
            .read(true)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&root)
            .unwrap();
        assert!(mkdir_child_at_handle(
            root_handle.as_raw_handle() as HANDLE,
            "owned-child",
        )
        .unwrap());
        for _ in 0..128 {
            assert!(!mkdir_child_at_handle(
                root_handle.as_raw_handle() as HANDLE,
                "owned-child",
            )
            .unwrap());
        }
        fs::remove_dir(root.join("owned-child")).unwrap();
        assert!(mkdir_child_at_handle(
            root_handle.as_raw_handle() as HANDLE,
            "owned-child",
        )
        .unwrap());
        fs::create_dir(root.join("nested")).unwrap();
        for invalid in ["", ".", "..", "nested/child", "nested\\child", "nul\0child"] {
            assert_eq!(
                mkdir_child_at_handle(root_handle.as_raw_handle() as HANDLE, invalid)
                    .unwrap_err()
                    .status,
                "EINVAL",
            );
        }
        assert_eq!(fs::read_dir(root.join("nested")).unwrap().count(), 0);
        let created = nt_open_relative(
            root_handle.as_raw_handle() as HANDLE,
            "created-dir",
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_OPEN_IF,
            FILE_DIRECTORY_FILE,
        )
        .unwrap();
        drop(created);
        assert!(root.join("created-dir").is_dir());
        // Windows Rust file handles are not CRT descriptors, so exercise the
        // handle-relative primitive directly in this platform unit test.
        let source = nt_open_relative(
            root_handle.as_raw_handle() as HANDLE,
            "source",
            FILE_READ_ATTRIBUTES | DELETE_ACCESS,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )
        .unwrap();
        let error = set_rename_information(
            source.0,
            root_handle.as_raw_handle() as HANDLE,
            "target",
            false,
            "rename without replacement",
        )
        .unwrap_err();
        assert_eq!(error.status, "EEXIST");
        assert_eq!(fs::read(root.join("target")).unwrap(), b"target");
        drop(source);

        fs::write(root.join("replacement"), b"replacement").unwrap();
        let replacement = nt_open_relative(
            root_handle.as_raw_handle() as HANDLE,
            "replacement",
            FILE_READ_ATTRIBUTES | DELETE_ACCESS,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )
        .unwrap();
        set_rename_information(
            replacement.0,
            root_handle.as_raw_handle() as HANDLE,
            "target",
            true,
            "rename with replacement",
        )
        .unwrap();
        assert_eq!(fs::read(root.join("target")).unwrap(), b"replacement");
        drop(replacement);

        for (index, target_name) in ["a", "é"].into_iter().enumerate() {
            let source_name = format!("short-source-{index}");
            fs::write(root.join(&source_name), target_name.as_bytes()).unwrap();
            let source = nt_open_relative(
                root_handle.as_raw_handle() as HANDLE,
                &source_name,
                FILE_READ_ATTRIBUTES | DELETE_ACCESS,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE,
            )
            .unwrap();
            set_rename_information(
                source.0,
                root_handle.as_raw_handle() as HANDLE,
                target_name,
                false,
                "rename short target",
            )
            .unwrap();
            drop(source);
            assert_eq!(
                fs::read(root.join(target_name)).unwrap(),
                target_name.as_bytes()
            );
        }

        fs::write(root.join("link-source"), b"linked").unwrap();
        let link_source = nt_open_relative(
            root_handle.as_raw_handle() as HANDLE,
            "link-source",
            FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE,
        )
        .unwrap();
        set_link_information(link_source.0, root_handle.as_raw_handle() as HANDLE, "l").unwrap();
        drop(link_source);
        assert_eq!(fs::read(root.join("l")).unwrap(), b"linked");

        fs::remove_dir_all(root).unwrap();
    }
}
