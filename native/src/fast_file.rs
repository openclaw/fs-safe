use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::{into_napi, platform};
use crate::task::{NativeTask, cancellation, checked_max_bytes};

#[napi(object)]
pub struct FileHash {
    pub bytes: f64,
    pub digest: String,
}

#[napi(object)]
pub struct NativeCopyResult {
    pub fd: i32,
    pub bytes: f64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[napi(js_name = "cloneFileExclusive")]
pub fn clone_file_exclusive(
    env: Env,
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<i32> {
    into_napi(
        env,
        crate::validate_relative_path(&target_rel_path, false).and_then(|()| {
            platform::clone_file_exclusive(source_fd, target_root_fd, &target_rel_path)
        }),
    )
}

#[napi(js_name = "copyFileRangeExclusive")]
pub fn copy_file_range_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<AsyncTask<NativeTask<NativeCopyResult>>> {
    crate::validate_relative_path(&target_rel_path, false)
        .map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    Ok(AsyncTask::new(NativeTask::new(move || {
        let copied = platform::copy_file_range_exclusive(
            source_fd,
            target_root_fd,
            &target_rel_path,
        );
        Ok(match copied {
            Ok((fd, bytes)) => NativeCopyResult {
                fd,
                bytes: bytes as f64,
                error_code: None,
                error_message: None,
            },
            Err(error) => NativeCopyResult {
                fd: -1,
                bytes: 0.0,
                error_code: Some(error.status),
                error_message: Some(error.reason),
            },
        })
    })))
}

struct HashFile {
    fd: i32,
    max_bytes: u64,
    cancelled: Arc<AtomicBool>,
}

impl HashFile {
    fn check_cancelled(&self) -> crate::NativeResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(crate::native_error(
                "Cancelled",
                "SHA-256 operation aborted",
            ));
        }
        Ok(())
    }

    fn hash(&self) -> crate::NativeResult<(u64, String)> {
        self.check_cancelled()?;
        let reader = platform::open_independent_reader(self.fd)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut bytes = 0_u64;
        loop {
            self.check_cancelled()?;
            let length = (self.max_bytes - bytes)
                .saturating_add(1)
                .min(buffer.len() as u64) as usize;
            let read = platform::read_at(&reader, &mut buffer[..length], bytes)?;
            self.check_cancelled()?;
            if read as u64 > self.max_bytes - bytes {
                return Err(crate::native_error(
                    "too-large",
                    "SHA-256 input exceeds maxBytes",
                ));
            }
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            bytes += read as u64;
        }
        let mut digest = String::with_capacity(64);
        for byte in hasher.finalize() {
            write!(&mut digest, "{byte:02x}").unwrap();
        }
        Ok((bytes, digest))
    }
}

#[napi(js_name = "sha256File")]
pub fn sha256_file(
    fd: i32,
    max_bytes: Option<f64>,
    signal: Option<AbortSignal>,
) -> Result<AsyncTask<NativeTask<FileHash>>> {
    let max_bytes = checked_max_bytes(max_bytes)?;
    let cancelled = cancellation(signal.as_ref());
    Ok(AsyncTask::with_optional_signal(
        NativeTask::new(move || {
            let (bytes, digest) = HashFile {
                fd,
                max_bytes,
                cancelled,
            }.hash()?;
            Ok(FileHash {
                bytes: bytes as f64,
                digest,
            })
        }),
        signal,
    ))
}
