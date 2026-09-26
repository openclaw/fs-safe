//! Local NTFS admission. All handles stay private to the retained-file owner.
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use sha2::{Digest, Sha256};
use windows_sys::Wdk::Storage::FileSystem::{FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE};
use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_NOT_FOUND};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::{CancelIoEx, DeviceIoControl, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Ioctl::{FSCTL_REQUEST_OPLOCK, REQUEST_OPLOCK_INPUT_BUFFER, REQUEST_OPLOCK_OUTPUT_BUFFER, OPLOCK_LEVEL_CACHE_READ, REQUEST_OPLOCK_INPUT_FLAG_REQUEST};
use windows_sys::Win32::System::Threading::CreateEventW;
use crate::{NativeResult, native_error};
use crate::windows::{OwnedHandle, open_retained_child, handle_attributes, handle_file_identity, handle_identity_and_size, win_error};

pub(super) fn basename(name: &str) -> NativeResult<()> {
    crate::validate_child_basename(name)?;
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit())
    { return Err(native_error("EINVAL", "retention requires an unambiguous Windows basename")); }
    Ok(())
}

pub(super) fn path_parts(path: &str) -> NativeResult<Vec<&str>> {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1..3] != *b":\\" || path.contains('/') {
        return Err(native_error("ENOTSUP", "retention requires a canonical local drive-absolute path"));
    }
    let parts: Vec<_> = path[3..].split('\\').collect();
    if path.len() > 3 { for part in &parts { basename(part)?; } }
    Ok(if path.len() == 3 { Vec::new() } else { parts })
}

pub(super) fn root(path: &str) -> NativeResult<OwnedHandle> {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    // Fixed local drives only; network, removable and namespace aliases are unsupported.
    if unsafe { GetDriveTypeW(wide.as_ptr()) } != 3 /* DRIVE_FIXED */ {
        return Err(native_error("ENOTSUP", "retained files require a fixed local NTFS drive"));
    }
    let handle = unsafe { CreateFileW(wide.as_ptr(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
    if handle == INVALID_HANDLE_VALUE { return Err(win_error(unsafe { GetLastError() }, "retain volume root")); }
    Ok(OwnedHandle(handle))
}

pub(super) fn directory(parent: HANDLE, name: &str) -> NativeResult<OwnedHandle> {
    open_retained_child(parent, name, FILE_LIST_DIRECTORY, FILE_DIRECTORY_FILE,
        FILE_SHARE_READ | FILE_SHARE_WRITE)
}

pub(super) fn file(parent: HANDLE, name: &str) -> NativeResult<OwnedHandle> {
    open_retained_child(parent, name, FILE_GENERIC_READ | DELETE,
        FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ)
}

pub(super) fn check_directory(handle: HANDLE) -> NativeResult<()> {
    let attrs = handle_attributes(handle)?;
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 || attrs & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(native_error("path-mismatch", "retained parent is not an ordinary directory"));
    }
    Ok(())
}

pub(super) fn check_ntfs(handle: HANDLE) -> NativeResult<()> {
    let mut name = [0u16; 32];
    if unsafe { GetVolumeInformationByHandleW(handle, null_mut(), 0, null_mut(), null_mut(), null_mut(), name.as_mut_ptr(), name.len() as u32) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "inspect retained volume"));
    }
    let n = name.iter().position(|x| *x == 0).unwrap_or(name.len());
    if String::from_utf16_lossy(&name[..n]) != "NTFS" {
        return Err(native_error("ENOTSUP", "retained-file disposition is qualified only for local NTFS"));
    }
    Ok(())
}

pub(super) fn canonical(handle: HANDLE, expected: &str) -> NativeResult<()> {
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), buf.len() as u32, 0) } as usize;
    if n == 0 || n >= buf.len() { return Err(native_error("path-mismatch", "retained directory path is unavailable")); }
    let observed = String::from_utf16(&buf[..n]).map_err(|_| native_error("ENOTSUP", "invalid directory spelling"))?;
    if !observed.strip_prefix(r"\\?\").unwrap_or(&observed).eq_ignore_ascii_case(expected) {
        return Err(native_error("path-mismatch", "retained directory has another canonical path"));
    }
    Ok(())
}

pub(super) fn exact(handle: HANDLE, dev: u64, ino: u64, directory: bool) -> NativeResult<String> {
    let ((d, i, is_dir), _) = handle_identity_and_size(handle)?;
    if dev == 0 || ino == 0 || d as u64 != dev || i != ino || is_dir != directory {
        return Err(native_error("path-mismatch", "retained object does not match expected exact identity"));
    }
    let identity = handle_file_identity(handle)?.to_string();
    if identity.ends_with(":00000000000000000000000000000000") {
        return Err(native_error("ENOTSUP", "unknown retained object identity"));
    }
    Ok(identity)
}

pub(super) fn regular(handle: HANDLE, size: u64) -> NativeResult<()> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "inspect retained regular file"));
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || info.nNumberOfLinks != 1 || ((info.nFileSizeHigh as u64) << 32 | info.nFileSizeLow as u64) != size {
        return Err(native_error("path-mismatch", "retained file type, link count or size changed"));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_READONLY != 0 {
        return Err(native_error("EACCES", "retained file is read-only"));
    }
    Ok(())
}

/// Share denial excludes writer handles, but not preexisting writable sections.
/// A read-oplock grant additionally excludes those sections. Cancel and join it
/// before returning; the retained no-write-sharing handle prevents new writers.
pub(super) fn exclude_writable_sections(handle: HANDLE, receipt: &mut super::RetainedFileResult) -> NativeResult<()> {
    let event = unsafe { CreateEventW(null(), 1, 0, null()) };
    if event.is_null() { return Err(win_error(unsafe { GetLastError() }, "create oplock event")); }
    let event = OwnedHandle(event);
    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    overlapped.hEvent = event.0;
    let input = REQUEST_OPLOCK_INPUT_BUFFER { StructureVersion: 1, StructureLength: size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u16,
        RequestedOplockLevel: OPLOCK_LEVEL_CACHE_READ, Flags: REQUEST_OPLOCK_INPUT_FLAG_REQUEST };
    let mut output: REQUEST_OPLOCK_OUTPUT_BUFFER = unsafe { zeroed() };
    let requested = unsafe { DeviceIoControl(handle, FSCTL_REQUEST_OPLOCK,
        (&input as *const REQUEST_OPLOCK_INPUT_BUFFER).cast(), size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u32,
        (&mut output as *mut REQUEST_OPLOCK_OUTPUT_BUFFER).cast(), size_of::<REQUEST_OPLOCK_OUTPUT_BUFFER>() as u32,
        null_mut(), &mut overlapped) };
    let code = if requested == 0 { unsafe { GetLastError() } } else { 0 };
    let result = if code != ERROR_IO_PENDING {
        Err(native_error("ENOTSUP", format!("writable-section exclusion was not granted (Windows error {code})")))
    } else {
        // Every pending request is joined while its stack buffers and event live.
        let cancelled = unsafe { CancelIoEx(handle, &overlapped) };
        let cancel_code = if cancelled == 0 { unsafe { GetLastError() } } else { 0 };
        let mut bytes = 0;
        let joined = unsafe { GetOverlappedResult(handle, &overlapped, &mut bytes, 1) };
        let join_code = if joined == 0 { unsafe { GetLastError() } } else { 0 };
        if cancel_code != 0 && cancel_code != ERROR_NOT_FOUND {
            receipt.error("cancel-oplock", win_error(cancel_code, "cancel retained-file oplock"));
        }
        if join_code != 0 && join_code != ERROR_OPERATION_ABORTED {
            Err(win_error(join_code, "join retained-file oplock"))
        } else if cancel_code != 0 && cancel_code != ERROR_NOT_FOUND {
            Err(win_error(cancel_code, "cancel retained-file oplock"))
        } else { Ok(()) }
    };
    if let Err(error) = event.close() {
        receipt.resources = "close-failed".into();
        receipt.error("close-oplock-event", error);
        return result.and_then(|()| Err(native_error("EIO", "oplock event settlement failed")));
    }
    result
}

pub(super) fn digest(handle: HANDLE, size: u64) -> NativeResult<String> {
    let mut hash = Sha256::new();
    let mut offset = 0u64;
    let mut buffer = [0u8; 65536];
    while offset < size {
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.Anonymous.Anonymous.Offset = offset as u32;
        overlapped.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
        let wanted = (size - offset).min(buffer.len() as u64) as u32;
        let mut read = 0;
        let ok = unsafe { ReadFile(handle, buffer.as_mut_ptr(), wanted, &mut read, &mut overlapped) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING { return Err(win_error(code, "read retained bytes")); }
            if unsafe { GetOverlappedResult(handle, &overlapped, &mut read, 1) } == 0 {
                return Err(win_error(unsafe { GetLastError() }, "join retained read"));
            }
        }
        if read == 0 || read > wanted { return Err(native_error("path-mismatch", "retained file length changed")); }
        hash.update(&buffer[..read as usize]); offset += read as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn disposition(handle: HANDLE) -> NativeResult<()> {
    // Deliberately never ignore readonly attributes or repair permissions.
    let info = FILE_DISPOSITION_INFO_EX { Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS | FILE_DISPOSITION_FLAG_FORCE_IMAGE_SECTION_CHECK };
    unsafe { crate::windows::set_file_information(handle, FileDispositionInfoEx, &info) }
        .map_err(|code| win_error(code, "set retained-file disposition"))
}

// Refuse observed named data streams: deleting an unnamed file also deletes them.
pub(super) fn no_named_streams(handle: HANDLE) -> NativeResult<()> {
    let mut words = vec![0usize; 65536 / size_of::<usize>()];
    if unsafe { GetFileInformationByHandleEx(handle, FileStreamInfo, words.as_mut_ptr().cast(), 65536) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "inspect retained data streams"));
    }
    let mut offset = 0usize;
    loop {
        let header = size_of::<FILE_STREAM_INFO>();
        if offset + header > 65536 { return Err(native_error("ENOTSUP", "invalid stream enumeration")); }
        let info = unsafe { &*words.as_ptr().cast::<u8>().add(offset).cast::<FILE_STREAM_INFO>() };
        let start = offset + std::mem::offset_of!(FILE_STREAM_INFO, StreamName);
        let length = info.StreamNameLength as usize;
        if length % 2 != 0 || start + length > 65536 { return Err(native_error("ENOTSUP", "invalid stream name")); }
        let name = unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>().add(start).cast::<u16>(), length / 2) };
        if String::from_utf16_lossy(name) != "::$DATA" { return Err(native_error("ENOTSUP", "named data streams are unsupported for file retirement")); }
        if info.NextEntryOffset == 0 { return Ok(()); }
        let next = info.NextEntryOffset as usize;
        if next < header || next % std::mem::align_of::<FILE_STREAM_INFO>() != 0 { return Err(native_error("ENOTSUP", "invalid next stream offset")); }
        offset = offset.checked_add(next).ok_or_else(|| native_error("ENOTSUP", "invalid stream offset"))?;
    }
}

pub(super) fn stamps(handle: HANDLE, mtime_ns: u64, ctime_ns: u64) -> NativeResult<()> {
    let mut info: FILE_BASIC_INFO = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandleEx(handle, FileBasicInfo, (&mut info as *mut FILE_BASIC_INFO).cast(), size_of::<FILE_BASIC_INFO>() as u32) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "inspect retained write generation"));
    }
    let epoch = 11644473600000000000i128;
    if info.LastWriteTime as i128 * 100 - epoch != mtime_ns as i128 || info.ChangeTime as i128 * 100 - epoch != ctime_ns as i128 {
        return Err(native_error("path-mismatch", "retained write generation changed"));
    }
    Ok(())
}
