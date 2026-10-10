use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use windows_sys::Win32::Foundation::{ERROR_HANDLE_EOF, ERROR_MORE_DATA, GENERIC_READ, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::FSCTL_GET_RETRIEVAL_POINTERS;
use crate::{NativeResult, into_napi, native_error, validate_windows_filesystem_path};
use crate::windows::{OwnedHandle, handle_is_reparse, win_error};

fn open(path: &str, access: u32, sharing: u32) -> NativeResult<OwnedHandle> {
    validate_windows_filesystem_path(path)?;
    if path.contains('\0') { return Err(native_error("EINVAL", "path contains NUL")); }
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let raw = unsafe { CreateFileW(wide.as_ptr(), access, sharing, null(), OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, null_mut()) };
    if raw == INVALID_HANDLE_VALUE { return Err(win_error(unsafe { GetLastError() }, "open test fixture")); }
    let handle = OwnedHandle(raw);
    if handle_is_reparse(raw)? { return Err(native_error("ELOOP", "test fixture is a reparse point")); }
    Ok(handle)
}

#[napi]
pub struct WindowsSharingLock { handle: Option<OwnedHandle> }

#[napi]
impl WindowsSharingLock {
    #[napi]
    pub fn close(&mut self, env: Env) -> Result<()> {
        into_napi(env, self.handle.take().map_or(Ok(()), OwnedHandle::close))
    }
}

#[napi(js_name = "holdWindowsSharingLock")]
pub fn hold_windows_sharing_lock(env: Env, path: String) -> Result<WindowsSharingLock> {
    into_napi(env, open(&path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE)
        .map(|handle| WindowsSharingLock { handle: Some(handle) }))
}

#[napi(object)]
pub struct WindowsFileAttributes {
    pub read_only: Option<bool>,
    pub hidden: Option<bool>,
    pub system: Option<bool>,
}

fn set_attributes(path: &str, attrs: WindowsFileAttributes) -> NativeResult<()> {
    let handle = open(path, FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)?;
    let mut info: FILE_BASIC_INFO = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandleEx(handle.0, FileBasicInfo,
        (&mut info as *mut FILE_BASIC_INFO).cast(), size_of::<FILE_BASIC_INFO>() as u32) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "read test fixture attributes"));
    }
    for (setting, flag) in [(attrs.read_only, FILE_ATTRIBUTE_READONLY),
        (attrs.hidden, FILE_ATTRIBUTE_HIDDEN), (attrs.system, FILE_ATTRIBUTE_SYSTEM)] {
        if let Some(enabled) = setting {
            if enabled { info.FileAttributes |= flag; } else { info.FileAttributes &= !flag; }
        }
    }
    info.FileAttributes &= !FILE_ATTRIBUTE_NORMAL;
    if info.FileAttributes == 0 { info.FileAttributes = FILE_ATTRIBUTE_NORMAL; }
    // Zero timestamps preserve the existing times on the pinned object.
    info.CreationTime = 0; info.LastAccessTime = 0; info.LastWriteTime = 0; info.ChangeTime = 0;
    if unsafe { SetFileInformationByHandle(handle.0, FileBasicInfo,
        (&info as *const FILE_BASIC_INFO).cast(), size_of::<FILE_BASIC_INFO>() as u32) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "set test fixture attributes"));
    }
    Ok(())
}

#[napi(js_name = "setWindowsFileAttributes")]
pub fn set_windows_file_attributes(env: Env, path: String, attrs: WindowsFileAttributes) -> Result<()> {
    into_napi(env, set_attributes(&path, attrs))
}

#[napi(object)]
pub struct WindowsFileExtent { pub vcn: BigInt, pub lcn: BigInt, pub clusters: BigInt }

fn extents(path: &str) -> NativeResult<Vec<WindowsFileExtent>> {
    let handle = open(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)?;
    let mut start = 0i64;
    let mut extents = Vec::new();
    loop {
        let mut output = [0u8; 65536];
        let mut returned = 0;
        let success = unsafe { DeviceIoControl(handle.0, FSCTL_GET_RETRIEVAL_POINTERS,
            (&start as *const i64).cast(), 8, output.as_mut_ptr().cast(), output.len() as u32,
            &mut returned, null_mut()) };
        let error = if success == 0 { unsafe { GetLastError() } } else { 0 };
        if error == ERROR_HANDLE_EOF { return Ok(extents); }
        if success == 0 && error != ERROR_MORE_DATA {
            return Err(win_error(error, "read test fixture extents"));
        }
        let count = u32::from_le_bytes(output[0..4].try_into().unwrap()) as usize;
        if count == 0 || returned as usize > output.len() || 16 + count * 16 > returned as usize {
            return Err(native_error("EIO", "invalid extent response length"));
        }
        let mut vcn = i64::from_le_bytes(output[8..16].try_into().unwrap());
        if vcn != start { return Err(native_error("EIO", "extent response did not start at requested VCN")); }
        for index in 0..count {
            let offset = 16 + index * 16;
            let next = i64::from_le_bytes(output[offset..offset+8].try_into().unwrap());
            let lcn = i64::from_le_bytes(output[offset+8..offset+16].try_into().unwrap());
            if next <= vcn || lcn < -1 { return Err(native_error("EIO", "invalid extent range")); }
            extents.push(WindowsFileExtent { vcn: vcn.into(), lcn: lcn.into(), clusters: (next-vcn).into() });
            vcn = next;
        }
        if success != 0 { return Ok(extents); }
        start = vcn;
    }
}

#[napi(js_name = "readWindowsFileExtents")]
pub fn read_windows_file_extents(env: Env, path: String) -> Result<Vec<WindowsFileExtent>> {
    into_napi(env, extents(&path))
}
