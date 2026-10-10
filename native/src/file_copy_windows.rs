use std::ptr::null_mut;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use windows_sys::Wdk::Storage::FileSystem::{FILE_CREATE, FILE_NON_DIRECTORY_FILE};
use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_END_OF_FILE_INFO, FILE_FLAG_NO_BUFFERING, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_TYPE_DISK, FileEndOfFileInfo, GetFileType, ReOpenFile,
    WriteFile,
};

use crate::clone_windows::{clone_file_data, is_refs, reject_named_streams};
use crate::task::{cancellation, checked_max_bytes};
use crate::windows::{
    OwnedHandle, ReparsePolicy, duplicate_handle, handle_identity_and_size, handle_is_reparse,
    mark_clone_handle_for_deletion, nt_open_relative_with_policy, open_independent_reader_handle,
    read_at, root_handle, runtime_fd_from_handle, set_file_information, win_error,
};
use crate::{NativeResult, native_error, validate_child_basename};

#[napi(object)]
pub struct NativeFileCopyResult {
    pub fd: i32,
    pub method: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

// Owned handles may cross to the libuv worker; no thread concurrently mutates them.
struct RetainedHandle(OwnedHandle);
unsafe impl Send for RetainedHandle {}

pub struct CreatedCopy {
    target: RetainedHandle,
    method: &'static str,
    error: Option<crate::NativeError>,
    released: bool,
}
unsafe impl Send for CreatedCopy {}

impl Drop for CreatedCopy {
    fn drop(&mut self) {
        if !self.released {
            let _ = mark_clone_handle_for_deletion(self.target.0.0);
        }
    }
}

pub struct FileCopyTask {
    source: RetainedHandle,
    parent: RetainedHandle,
    name: String,
    clone_mode: String,
    max_bytes: u64,
    cancelled: Arc<AtomicBool>,
}

impl Task for FileCopyTask {
    type Output = NativeResult<CreatedCopy>;
    type JsValue = NativeFileCopyResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.copy())
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let mut created = crate::into_napi(env, output)?;
        if created.error.is_none() {
            created.error = self.check_cancelled().err();
        }
        // Keep the original cleanup handle until the runtime has adopted its duplicate.
        let fd = crate::into_napi(
            env,
            duplicate_handle(created.target.0.0, "retain copy result")
                .and_then(runtime_fd_from_handle),
        )?;
        created.released = true;
        let (error_code, error_message) = created.error.take().map_or((None, None), |error| {
            (Some(error.status), Some(error.reason))
        });
        Ok(NativeFileCopyResult {
            fd,
            method: created.method.into(),
            error_code,
            error_message,
        })
    }
}

impl FileCopyTask {
    fn check_cancelled(&self) -> NativeResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(native_error("Cancelled", "file copy aborted"));
        }
        Ok(())
    }

    fn check_source(&self) -> NativeResult<u64> {
        let source = self.source.0.0;
        let (identity, size) = handle_identity_and_size(source)?;
        if unsafe { GetFileType(source) } != FILE_TYPE_DISK
            || identity.2
            || handle_is_reparse(source)?
        {
            return Err(native_error("EINVAL", "copy requires an ordinary file"));
        }
        if size > self.max_bytes {
            return Err(native_error("too-large", "copy input exceeds maxBytes"));
        }
        Ok(size)
    }

    fn check_clone_streams(&self) -> NativeResult<()> {
        // A content rejection must never become an automatic byte-copy retry.
        reject_named_streams(self.source.0.0).map_err(|mut error| {
            if error.status == "ENOTSUP" {
                error.status = "EIO".into();
            }
            error
        })
    }

    fn copy(&self) -> NativeResult<CreatedCopy> {
        self.copy_with_before_source_lock(|| {})
    }

    fn copy_with_before_source_lock(
        &self,
        before_lock: impl FnOnce(),
    ) -> NativeResult<CreatedCopy> {
        self.check_cancelled()?;
        self.check_source()?;
        if self.clone_mode != "never" {
            if !is_refs(self.parent.0.0)? {
                return Err(native_error("ENOTSUP", "file cloning requires ReFS"));
            }
            self.check_clone_streams()?;
            if !is_refs(self.source.0.0)?
                || handle_identity_and_size(self.source.0.0)?.0.0
                    != handle_identity_and_size(self.parent.0.0)?.0.0
            {
                return Err(native_error(
                    "ENOTSUP",
                    "file cloning requires the same ReFS volume",
                ));
            }
        }
        before_lock();
        let clone_source = if self.clone_mode == "never" {
            None
        } else {
            // Match the tree cloner: pin this object without buffering, and exclude
            // writers until cloning settles. ReOpenFile never resolves a pathname.
            let handle = unsafe {
                ReOpenFile(
                    self.source.0.0,
                    FILE_GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_DELETE,
                    FILE_FLAG_NO_BUFFERING,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(win_error(unsafe { GetLastError() }, "reopen clone source"));
            }
            Some(OwnedHandle(handle))
        };
        // Recheck all content admission after excluding writers, including streams
        // created since the first sample. Neither length nor stream facts may be stale.
        if clone_source.is_some() {
            self.check_clone_streams()?;
        }
        let size = self.check_source()?;
        let target = nt_open_relative_with_policy(
            self.parent.0.0,
            &self.name,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
            ReparsePolicy::Reject,
        )?;
        let mut created = CreatedCopy {
            target: RetainedHandle(target),
            method: "clone",
            error: None,
            released: false,
        };
        created.error = (|| {
            self.check_cancelled()?;
            if self.clone_mode == "never" {
                self.copy_bytes(created.target.0.0)?;
                created.method = "copy";
            } else if let Err(error) = clone_file_data(
                clone_source.as_ref().unwrap().0,
                created.target.0.0,
                size,
                &self.cancelled,
                true,
            ) {
                if self.clone_mode == "always"
                    || !matches!(
                        error.status.as_str(),
                        "ENOTSUP" | "EXDEV" | "EINVAL" | "ENOSYS"
                    )
                {
                    return Err(error);
                }
                self.copy_bytes(created.target.0.0)?;
                created.method = "copy";
            }
            self.check_cancelled()?;
            self.check_source()?;
            let (_, copied_size) = handle_identity_and_size(created.target.0.0)?;
            if copied_size > self.max_bytes {
                return Err(native_error("too-large", "copy output exceeds maxBytes"));
            }
            Ok(())
        })()
        .err();
        Ok(created)
    }

    fn copy_bytes(&self, target: HANDLE) -> NativeResult<()> {
        self.check_cancelled()?;
        let eof = FILE_END_OF_FILE_INFO { EndOfFile: 0 };
        // Discard any partially cloned extents before the bounded byte retry.
        unsafe { set_file_information(target, FileEndOfFileInfo, &eof) }
            .map_err(|code| win_error(code, "reset copy stage"))?;
        let reader = open_independent_reader_handle(self.source.0.0)?;
        let mut buffer = [0_u8; 64 * 1024];
        let mut offset = 0_u64;
        loop {
            self.check_cancelled()?;
            let length = (self.max_bytes - offset)
                .saturating_add(1)
                .min(buffer.len() as u64) as usize;
            let read = read_at(&reader, &mut buffer[..length], offset)?;
            self.check_cancelled()?;
            if read as u64 > self.max_bytes - offset {
                return Err(native_error("too-large", "copy input exceeds maxBytes"));
            }
            if read == 0 {
                return Ok(());
            }
            let mut written = 0;
            while written < read {
                self.check_cancelled()?;
                let mut count = 0;
                if unsafe {
                    WriteFile(
                        target,
                        buffer[written..read].as_ptr(),
                        (read - written) as u32,
                        &mut count,
                        null_mut(),
                    )
                } == 0
                {
                    return Err(win_error(unsafe { GetLastError() }, "write copy stage"));
                }
                if count == 0 {
                    return Err(native_error("EIO", "copy write made no progress"));
                }
                written += count as usize;
            }
            offset += read as u64;
        }
    }
}

#[napi(js_name = "copyFileExclusive")]
pub fn copy_file_exclusive(
    env: Env,
    source_fd: i32,
    parent_fd: i32,
    basename: String,
    clone_mode: String,
    max_bytes: Option<f64>,
    signal: Option<AbortSignal>,
) -> Result<AsyncTask<FileCopyTask>> {
    let max_bytes = checked_max_bytes(max_bytes)?;
    if !matches!(clone_mode.as_str(), "never" | "auto" | "always") {
        return Err(Error::new(Status::InvalidArg, "invalid copy clone mode"));
    }
    let task = (|| {
        validate_child_basename(&basename)?;
        Ok(FileCopyTask {
            source: RetainedHandle(duplicate_handle(
                root_handle(source_fd)?,
                "retain copy source",
            )?),
            parent: RetainedHandle(duplicate_handle(
                root_handle(parent_fd)?,
                "retain copy parent",
            )?),
            name: basename,
            clone_mode,
            max_bytes,
            cancelled: cancellation(signal.as_ref()),
        })
    })();
    crate::into_napi(env, task).map(AsyncTask::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{directory, unique_path_in};
    use std::{fs, os::windows::io::AsRawHandle};

    #[test]
    fn unreturned_copy_stage_is_removed_on_refs() {
        let explicit = std::env::var_os("FS_SAFE_CLONE_TEST_ROOT");
        let base = explicit.clone().map_or_else(std::env::temp_dir, Into::into);
        let base_handle = directory(&base);
        if !is_refs(base_handle.as_raw_handle()).unwrap() {
            assert!(explicit.is_none(), "FS_SAFE_CLONE_TEST_ROOT requires ReFS");
            return;
        }
        let scratch = unique_path_in(&base, "unreturned-copy");
        fs::create_dir(&scratch).unwrap();
        let parent = directory(&scratch);
        let target = nt_open_relative_with_policy(
            parent.as_raw_handle(),
            "stage",
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE,
            ReparsePolicy::Reject,
        )
        .unwrap();
        let created = CreatedCopy {
            target: RetainedHandle(target),
            method: "clone",
            error: None,
            released: false,
        };
        assert!(scratch.join("stage").exists());
        drop(created);
        assert!(!scratch.join("stage").exists());
        drop(parent);
        fs::remove_dir(scratch).unwrap();
    }

    #[test]
    fn clone_admission_is_rechecked_after_excluding_source_writers() {
        let explicit = std::env::var_os("FS_SAFE_CLONE_TEST_ROOT");
        let base = explicit.clone().map_or_else(std::env::temp_dir, Into::into);
        let base_handle = directory(&base);
        if !is_refs(base_handle.as_raw_handle()).unwrap() {
            assert!(explicit.is_none(), "FS_SAFE_CLONE_TEST_ROOT requires ReFS");
            return;
        }
        let scratch = unique_path_in(&base, "copy-source-growth");
        fs::create_dir(&scratch).unwrap();
        let source_path = scratch.join("source");
        let grown = vec![0x5a; 128 * 1024 + 1];
        for (max_bytes, add_stream) in [
            (grown.len() as u64, false),
            (grown.len() as u64 - 1, false),
            (grown.len() as u64, true),
        ] {
            fs::write(&source_path, b"small").unwrap();
            let source = fs::File::open(&source_path).unwrap();
            let parent = directory(&scratch);
            let task = FileCopyTask {
                source: RetainedHandle(
                    duplicate_handle(source.as_raw_handle(), "retain source").unwrap(),
                ),
                parent: RetainedHandle(
                    duplicate_handle(parent.as_raw_handle(), "retain parent").unwrap(),
                ),
                name: "stage".into(),
                clone_mode: "always".into(),
                max_bytes,
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            let copied = task.copy_with_before_source_lock(|| {
                fs::write(&source_path, &grown).unwrap();
                if add_stream {
                    fs::write(scratch.join("source:secret"), b"stream").unwrap();
                }
            });
            if add_stream {
                assert_eq!(copied.err().unwrap().status, "EIO");
            } else if max_bytes == grown.len() as u64 {
                let created = copied.unwrap();
                assert!(created.error.is_none());
                assert_eq!(fs::read(scratch.join("stage")).unwrap(), grown);
                drop(created);
            } else {
                assert_eq!(copied.err().unwrap().status, "too-large");
            }
            assert!(!scratch.join("stage").exists());
        }
        fs::remove_dir_all(scratch).unwrap();
    }
}
