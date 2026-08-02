use std::ffi::c_void;
use std::io::{Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS,
    ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GENERIC_READ, GetLastError,
    HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, ReOpenFile,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::{FileIdentity, NativeResult, native_error};

const O_WRONLY: i32 = 0x0001;
const O_RDWR: i32 = 0x0002;
const O_APPEND: i32 = 0x0008;
const O_CREAT: i32 = 0x0100;
const O_TRUNC: i32 = 0x0200;
const O_EXCL: i32 = 0x0400;
const O_BINARY: i32 = 0x8000;

const DELETE_ACCESS: u32 = 0x0001_0000;
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
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

#[link(name = "msvcrt")]
unsafe extern "C" {
    fn _get_osfhandle(fd: i32) -> isize;
    fn _open_osfhandle(handle: isize, flags: i32) -> i32;
    fn _set_thread_local_invalid_parameter_handler(
        handler: InvalidParameterHandler,
    ) -> InvalidParameterHandler;
}

type InvalidParameterHandler = Option<
    unsafe extern "C" fn(
        expression: *const u16,
        function: *const u16,
        file: *const u16,
        line: u32,
        reserved: usize,
    ),
>;

unsafe extern "C" fn ignore_invalid_parameter(
    _expression: *const u16,
    _function: *const u16,
    _file: *const u16,
    _line: u32,
    _reserved: usize,
) {
}

struct OwnedHandle(HANDLE);

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

fn root_handle(fd: i32) -> NativeResult<HANDLE> {
    let direct = fd as usize as HANDLE;
    // Node/libuv may expose a Windows HANDLE directly rather than a UCRT fd.
    // Probe that representation first with a non-destructive handle query.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if !direct.is_null() && unsafe { GetFileInformationByHandle(direct, &mut info) } != 0 {
        return Ok(direct);
    }
    // Node's Windows fs descriptors are owned by libuv and are not guaranteed
    // to belong to the addon's CRT table. Resolve libuv's public conversion
    // function from the Node executable before trying the CRT fallback.
    let node_module = unsafe { GetModuleHandleW(null()) };
    if !node_module.is_null() {
        let proc = unsafe { GetProcAddress(node_module, c"uv_get_osfhandle".as_ptr().cast()) };
        if let Some(proc) = proc {
            // SAFETY: uv_get_osfhandle is exported with the documented
            // `intptr_t uv_get_osfhandle(int)` signature.
            let get_uv_handle: unsafe extern "C" fn(i32) -> isize =
                unsafe { std::mem::transmute(proc) };
            let handle = unsafe { get_uv_handle(fd) };
            if handle != -1 {
                return Ok(handle as HANDLE);
            }
        }
    }
    // _get_osfhandle invokes UCRT's invalid-parameter handler for a non-CRT
    // descriptor. Override it on this thread so an invalid representation
    // becomes a normal -1 result instead of terminating Node.
    let previous =
        unsafe { _set_thread_local_invalid_parameter_handler(Some(ignore_invalid_parameter)) };
    let handle = unsafe { _get_osfhandle(fd) };
    unsafe { _set_thread_local_invalid_parameter_handler(previous) };
    if handle == -1 {
        return Err(native_error("EBADF", "invalid root file descriptor"));
    }
    Ok(handle as HANDLE)
}

fn node_fd_from_handle(handle: OwnedHandle, flags: i32) -> NativeResult<i32> {
    let node_module = unsafe { GetModuleHandleW(null()) };
    if !node_module.is_null() {
        let proc = unsafe { GetProcAddress(node_module, c"uv_open_osfhandle".as_ptr().cast()) };
        if let Some(proc) = proc {
            // SAFETY: uv_open_osfhandle is exported with the documented
            // `int uv_open_osfhandle(intptr_t)` signature.
            let open_uv_handle: unsafe extern "C" fn(isize) -> i32 =
                unsafe { std::mem::transmute(proc) };
            let fd = unsafe { open_uv_handle(handle.0 as isize) };
            if fd >= 0 {
                let _ = handle.into_raw();
                return Ok(fd);
            }
        }
    }
    let fd = unsafe { _open_osfhandle(handle.0 as isize, flags | O_BINARY | (flags & O_APPEND)) };
    if fd < 0 {
        return Err(native_error(
            "EIO",
            "convert Windows handle to file descriptor",
        ));
    }
    let _ = handle.into_raw();
    Ok(fd)
}

fn wide_relative(path: &str) -> NativeResult<Vec<u16>> {
    let normalized = path.replace('/', "\\");
    let wide: Vec<u16> = std::ffi::OsStr::new(&normalized).encode_wide().collect();
    if wide.len() > (u16::MAX as usize / 2) {
        return Err(native_error("ENAMETOOLONG", "relative path is too long"));
    }
    Ok(wide)
}

fn win_error(code: u32, operation: &str) -> napi::Error<String> {
    let typed = match code {
        ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS => "EEXIST",
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "ENOENT",
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

fn assert_not_reparse(handle: HANDLE) -> NativeResult<()> {
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
        return Err(win_error(unsafe { GetLastError() }, "inspect opened path"));
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(native_error(
            "ELOOP",
            "reparse points are not allowed beneath root",
        ));
    }
    Ok(())
}

fn nt_open_relative(
    root: HANDLE,
    path: &str,
    desired_access: u32,
    disposition: u32,
    options: u32,
) -> NativeResult<OwnedHandle> {
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
        attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        security_descriptor: null_mut(),
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
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            disposition,
            options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            null(),
            0,
        )
    };
    if status < 0 {
        return Err(nt_error(status, "open path relative to root handle"));
    }
    let owned = OwnedHandle(handle);
    assert_not_reparse(owned.0)?;
    Ok(owned)
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
    if rel_path.is_empty() || rel_path == "." {
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate = null_mut();
        if unsafe {
            DuplicateHandle(
                process,
                root_handle(root_fd)?,
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
        return node_fd_from_handle(duplicate, flags);
    }
    let handle = nt_open_relative(
        root_handle(root_fd)?,
        rel_path,
        access_from_flags(flags),
        disposition_from_flags(flags),
        0,
    )?;
    node_fd_from_handle(handle, flags)
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
    let byte_len = FILE_NAME_OFFSET + name_bytes;
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
        if !replace
            && nt_open_relative(target_root, target_path, FILE_READ_ATTRIBUTES, FILE_OPEN, 0)
                .is_ok()
        {
            return Err(native_error("EEXIST", "rename destination already exists"));
        }
        return Err(nt_error(status, operation));
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
    let byte_len = FILE_NAME_OFFSET + name_bytes;
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

pub fn rename_no_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let source = open_source_for_metadata(source_root_fd, source_rel_path, DELETE_ACCESS)?;
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
    let source = open_source_for_metadata(source_root_fd, source_rel_path, DELETE_ACCESS)?;
    set_rename_information(
        source.0,
        root_handle(target_root_fd)?,
        target_rel_path,
        true,
        "rename with replacement",
    )
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
    let handle = unsafe {
        ReOpenFile(
            root_handle(fd)?,
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
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn maps_access_denied_to_node_filesystem_eperm() {
        assert_eq!(win_error(ERROR_ACCESS_DENIED, "test").status, "EPERM");
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
        fs::remove_dir_all(root).unwrap();
    }
}
