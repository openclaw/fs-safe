use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, JsError, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::{into_napi, platform};

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

pub struct CopyFileRangeTask {
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
}

impl Task for CopyFileRangeTask {
    type Output = crate::NativeResult<(i32, u64)>;
    type JsValue = NativeCopyResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(platform::copy_file_range_exclusive(
            self.source_fd,
            self.target_root_fd,
            &self.target_rel_path,
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
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
    }
}

#[napi(js_name = "copyFileRangeExclusive")]
pub fn copy_file_range_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<AsyncTask<CopyFileRangeTask>> {
    crate::validate_relative_path(&target_rel_path, false)
        .map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    Ok(AsyncTask::new(CopyFileRangeTask {
        source_fd,
        target_root_fd,
        target_rel_path,
    }))
}

pub struct HashTask {
    fd: i32,
    max_bytes: u64,
    cancelled: Arc<AtomicBool>,
}

impl Task for HashTask {
    type Output = crate::NativeResult<(u64, String)>;
    type JsValue = FileHash;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.hash())
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let (bytes, digest) =
            output.map_err(|error| Error::from(JsError::from(error).into_unknown(env)))?;
        Ok(FileHash {
            bytes: bytes as f64,
            digest,
        })
    }
}

impl HashTask {
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
) -> Result<AsyncTask<HashTask>> {
    let max_bytes = match max_bytes {
        Some(value)
            if value.is_finite()
                && (0.0..=9_007_199_254_740_991.0).contains(&value)
                && value.fract() == 0.0 =>
        {
            value as u64
        }
        Some(_) => {
            return Err(Error::new(
                Status::InvalidArg,
                "maxBytes must be a non-negative safe integer",
            ));
        }
        None => u64::MAX,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let callback = Arc::clone(&cancelled);
        signal.on_abort(move || callback.store(true, Ordering::Relaxed));
    }
    Ok(AsyncTask::with_optional_signal(
        HashTask {
            fd,
            max_bytes,
            cancelled,
        },
        signal,
    ))
}
