use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, JsError, Result};
use napi_derive::napi;
use std::ptr::null_mut;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::Foundation::{GENERIC_WRITE, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK, GetFileType, ReOpenFile,
    WriteFile,
};

use crate::windows::{
    OwnedHandle, handle_identity, handle_is_reparse, open_independent_reader, read_at, root_handle,
    win_error,
};
use crate::{NativeResult, native_error};

pub struct CopyFileContentsTask {
    source_fd: i32,
    target_fd: i32,
    cancelled: Arc<AtomicBool>,
}

fn check_cancelled(cancelled: &AtomicBool) -> NativeResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(native_error("ABORT_ERR", "file copy aborted"))
    } else {
        Ok(())
    }
}

fn copy_contents(source_fd: i32, target_fd: i32, cancelled: &AtomicBool) -> NativeResult<()> {
    check_cancelled(cancelled)?;
    let source_handle = root_handle(source_fd)?;
    let target_handle = root_handle(target_fd)?;
    let source_identity = handle_identity(source_handle)?;
    let target_identity = handle_identity(target_handle)?;
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
    let reader = open_independent_reader(source_fd)?;
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
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut offset = 0_u64;
    loop {
        check_cancelled(cancelled)?;
        let read = read_at(&reader, &mut buffer, offset)?;
        check_cancelled(cancelled)?;
        if read == 0 {
            return Ok(());
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

impl Task for CopyFileContentsTask {
    type Output = NativeResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(copy_contents(self.source_fd, self.target_fd, &self.cancelled))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<()> {
        output.map_err(|error| Error::from(JsError::from(error).into_unknown(env)))
    }
}

#[napi(js_name = "copyFileContents")]
pub fn copy_file_contents(
    source_fd: i32,
    target_fd: i32,
    signal: Option<AbortSignal>,
) -> AsyncTask<CopyFileContentsTask> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let flag = Arc::clone(&cancelled);
        signal.on_abort(move || flag.store(true, Ordering::Relaxed));
    }
    // AsyncTask must settle only after the worker stops using the borrowed fds.
    // Passing its signal would allow early rejection and caller-side close.
    AsyncTask::new(CopyFileContentsTask {
        source_fd,
        target_fd,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Seek, SeekFrom};
    use std::os::windows::io::AsRawHandle;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn copies_empty_and_multichunk_files_without_moving_caller_offsets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir()
            .join(format!("fs-safe-copy-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        for size in [0, 1, 1024 * 1024 + 17] {
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
            // root_handle supports Windows handles directly as well as Node fds.
            let source_fd = i32::try_from(source.as_raw_handle() as isize).unwrap();
            let target_fd = i32::try_from(target.as_raw_handle() as isize).unwrap();
            copy_contents(source_fd, target_fd, &AtomicBool::new(false)).unwrap();
            assert_eq!(source.stream_position().unwrap(), 3);
            assert_eq!(target.stream_position().unwrap(), 7);
            assert_eq!(fs::read(&target_path).unwrap(), contents);
            assert_eq!(fs::read(&source_path).unwrap(), contents);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
