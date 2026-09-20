use std::ptr::null_mut;
use std::sync::atomic::AtomicBool;

use crate::copy_contents::check_cancelled;
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, GENERIC_WRITE, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_CURRENT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
    GetFileType, ReOpenFile, SetEndOfFile, SetFilePointerEx, WriteFile,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;

use crate::windows::{
    OwnedHandle, handle_identity_and_size, handle_is_reparse, open_independent_reader_handle,
    read_at, root_handle, win_error,
};
use crate::{NativeResult, native_error};

fn enable_sparse(handle: HANDLE) -> NativeResult<bool> {
    let mut returned = 0;
    // SAFETY: the synchronous private writer remains open through this control call.
    if unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            null_mut(),
            0,
            &mut returned,
            null_mut(),
        )
    } != 0
    {
        return Ok(true);
    }
    let error = unsafe { GetLastError() };
    if matches!(error, ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED) {
        return Ok(false);
    }
    Err(win_error(error, "enable sparse copy target"))
}

fn copy_contents_handles(
    source_handle: HANDLE,
    target_handle: HANDLE,
    cancelled: &AtomicBool,
) -> NativeResult<()> {
    check_cancelled(cancelled)?;
    let (source_identity, source_size) = handle_identity_and_size(source_handle)?;
    let (target_identity, target_size) = handle_identity_and_size(target_handle)?;
    for (handle, identity) in [(source_handle, source_identity), (target_handle, target_identity)] {
        // SAFETY: the caller keeps both admitted file descriptors open until settlement.
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
            || identity.2
            || handle_is_reparse(handle)?
        {
            return Err(native_error("EINVAL", "file copy requires ordinary files"));
        }
    }
    if source_identity == target_identity {
        return Err(native_error("EINVAL", "file copy requires distinct files"));
    }
    let reader = open_independent_reader_handle(source_handle)?;
    // ReOpenFile keeps the checked object while giving this worker its own file
    // position. No pathname is reopened and the caller's target stays owned by it.
    // SAFETY: the target handle remains open and the returned handle is uniquely owned.
    let writer = unsafe {
        ReOpenFile(
            target_handle,
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            0,
        )
    };
    if writer == INVALID_HANDLE_VALUE {
        return Err(win_error(unsafe { GetLastError() }, "reopen copy target"));
    }
    let writer = OwnedHandle(writer);
    // Size only guides allocation; reading to EOF still handles a changed length.
    let mut buffer = vec![0_u8; source_size.clamp(4096, 1024 * 1024) as usize];
    let mut offset = 0_u64;
    // Existing targets need zero bytes overwritten and their untouched tail retained.
    let mut sparse_allowed = target_size == 0;
    let mut sparse_enabled = false;
    loop {
        check_cancelled(cancelled)?;
        let read = read_at(&reader, &mut buffer, offset)?;
        check_cancelled(cancelled)?;
        if read == 0 {
            if sparse_enabled {
                // Skipping a trailing zero range moves the private cursor but not EOF.
                // SAFETY: writer is synchronous and its cursor belongs to this copy.
                if unsafe { SetEndOfFile(writer.0) } == 0 {
                    return Err(win_error(
                        unsafe { GetLastError() },
                        "finish sparse copy target",
                    ));
                }
                check_cancelled(cancelled)?;
            }
            return Ok(());
        }
        // Avoid sparse setup for small zero files.
        if sparse_allowed
            && (sparse_enabled || read >= 64 * 1024)
            && buffer[..read].iter().all(|byte| *byte == 0)
        {
            check_cancelled(cancelled)?;
            if !sparse_enabled {
                sparse_enabled = enable_sparse(writer.0)?;
                sparse_allowed = sparse_enabled;
                check_cancelled(cancelled)?;
            }
            if sparse_enabled {
                // SAFETY: read fits the bounded buffer and only the private cursor moves.
                if unsafe { SetFilePointerEx(writer.0, read as i64, null_mut(), FILE_CURRENT) } == 0
                {
                    return Err(win_error(
                        unsafe { GetLastError() },
                        "skip copied zero range",
                    ));
                }
                offset += read as u64;
                continue;
            }
        }
        let mut written = 0;
        while written < read {
            check_cancelled(cancelled)?;
            let mut length = 0;
            // SAFETY: writer is synchronous and privately owned; the buffer and
            // byte count remain live until WriteFile completes every admitted I/O.
            if unsafe {
                WriteFile(
                    writer.0,
                    buffer[written..read].as_ptr(),
                    (read - written) as u32,
                    &mut length,
                    null_mut(),
                )
            } == 0
            {
                return Err(win_error(unsafe { GetLastError() }, "write copied file"));
            }
            if length == 0 {
                return Err(native_error("EIO", "file copy write made no progress"));
            }
            written += length as usize;
        }
        offset += read as u64;
    }
}

pub(crate) fn copy_contents(source_fd: i32, target_fd: i32, cancelled: &AtomicBool) -> NativeResult<()> {
    copy_contents_handles(root_handle(source_fd)?, root_handle(target_fd)?, cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_STANDARD_INFO, FileStandardInfo, GetFileInformationByHandleEx,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;

    fn digest(path: &Path) -> Vec<u8> {
        let mut file = File::open(path).unwrap();
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let read = file.read(&mut buffer).unwrap();
            if read == 0 {
                return hash.finalize().to_vec();
            }
            hash.update(&buffer[..read]);
        }
    }

    #[test]
    fn copies_sparse_holes_and_exact_eof_without_allocating_zero_chunks() {
        let base = fs::canonicalize(
            std::env::var_os("FS_SAFE_CLONE_TEST_ROOT").map_or_else(std::env::temp_dir, Into::into),
        )
        .unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = base.join(format!(
            "fs-safe-sparse-copy-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let owned = fs::canonicalize(&root).unwrap();
        assert_eq!(owned.parent(), Some(base.as_path()));
        for (size, markers) in [
            (128 * 1024 * 1024 + 17, true),
            (2 * 1024 * 1024 + 17, false),
        ] {
            let source_path = root.join(format!("source-{size}"));
            let target_path = root.join(format!("target-{size}"));
            let mut source = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&source_path)
                .unwrap();
            let mut returned = 0;
            assert_ne!(
                unsafe {
                    DeviceIoControl(
                        source.as_raw_handle(),
                        FSCTL_SET_SPARSE,
                        std::ptr::null(),
                        0,
                        null_mut(),
                        0,
                        &mut returned,
                        null_mut(),
                    )
                },
                0
            );
            source.set_len(size).unwrap();
            if markers {
                source.write_all(b"leading marker").unwrap();
                source.seek(SeekFrom::Start(size / 2 + 7)).unwrap();
                source.write_all(b"middle marker").unwrap();
            }
            let expected = digest(&source_path);
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target_path)
                .unwrap();
            source.seek(SeekFrom::Start(3)).unwrap();
            target.seek(SeekFrom::Start(7)).unwrap();
            copy_contents_handles(
                source.as_raw_handle(),
                target.as_raw_handle(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(source.stream_position().unwrap(), 3);
            assert_eq!(target.stream_position().unwrap(), 7);
            assert_eq!(fs::metadata(&target_path).unwrap().len(), size);
            assert_eq!(digest(&target_path), expected);
            let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    GetFileInformationByHandleEx(
                        target.as_raw_handle(),
                        FileStandardInfo,
                        (&mut info as *mut FILE_STANDARD_INFO).cast(),
                        std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
                    )
                },
                0
            );
            let allocation_limit = if markers {
                4 * 1024 * 1024
            } else {
                1024 * 1024
            };
            assert!(
                info.AllocationSize < allocation_limit,
                "allocated {} bytes",
                info.AllocationSize
            );
            target.seek(SeekFrom::Start(size - 1)).unwrap();
            target.write_all(&[99]).unwrap();
            assert_ne!(digest(&target_path), expected);
            assert_eq!(digest(&source_path), expected);
            eprintln!(
                "sparse byte copy: logical={size} allocated={} markers={markers} exact_bytes=true cursors_preserved=true independent=true",
                info.AllocationSize
            );
        }
        assert_eq!(fs::canonicalize(&root).unwrap(), owned);
        assert_eq!(owned.parent(), Some(base.as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_zero_bytes_over_existing_contents_and_preserves_target_tail() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = base.join(format!("fs-safe-copy-tail-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let owned = fs::canonicalize(&root).unwrap();
        assert_eq!(owned.parent(), Some(base.as_path()));
        {
            let source_path = root.join("source");
            let target_path = root.join("target");
            let size = 2 * 1024 * 1024 + 17;
            fs::write(&source_path, vec![0_u8; size]).unwrap();
            fs::write(&target_path, vec![123_u8; size + 4096]).unwrap();
            let mut source = File::open(&source_path).unwrap();
            let mut target = OpenOptions::new().write(true).open(&target_path).unwrap();
            source.seek(SeekFrom::Start(3)).unwrap();
            target.seek(SeekFrom::Start(7)).unwrap();
            copy_contents_handles(
                source.as_raw_handle(),
                target.as_raw_handle(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(source.stream_position().unwrap(), 3);
            assert_eq!(target.stream_position().unwrap(), 7);
            let contents = fs::read(&target_path).unwrap();
            assert_eq!(contents.len(), size + 4096);
            assert!(contents[..size].iter().all(|byte| *byte == 0));
            assert!(contents[size..].iter().all(|byte| *byte == 123));
            assert!(
                fs::read(&source_path)
                    .unwrap()
                    .iter()
                    .all(|byte| *byte == 0)
            );
        }
        assert_eq!(fs::canonicalize(&root).unwrap(), owned);
        assert_eq!(owned.parent(), Some(base.as_path()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_empty_and_multichunk_files_without_moving_caller_offsets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .join(format!("fs-safe-copy-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        for size in [0, 1, 4095, 4096, 4097, 65_537, 1024 * 1024 + 17] {
            let source_path = root.join(format!("source-{size}"));
            let target_path = root.join(format!("target-{size}"));
            let contents: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
            fs::write(&source_path, &contents).unwrap();
            let mut source = File::open(&source_path).unwrap();
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target_path)
                .unwrap();
            source.seek(SeekFrom::Start(3)).unwrap();
            target.seek(SeekFrom::Start(7)).unwrap();
            copy_contents_handles(
                source.as_raw_handle(),
                target.as_raw_handle(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(source.stream_position().unwrap(), 3);
            assert_eq!(target.stream_position().unwrap(), 7);
            assert_eq!(fs::read(&target_path).unwrap(), contents);
            assert_eq!(fs::read(&source_path).unwrap(), contents);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
