use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};

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

fn hash_file(
    fd: i32,
    max_bytes: u64,
    cancelled: &AtomicBool,
) -> crate::NativeResult<(u64, String)> {
    let check_cancelled = || {
        if cancelled.load(Ordering::Relaxed) {
            return Err(crate::native_error(
                "Cancelled",
                "SHA-256 operation aborted",
            ));
        }
        Ok(())
    };
    check_cancelled()?;
    let reader = platform::open_independent_reader(fd)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    loop {
        check_cancelled()?;
        let length = (max_bytes - bytes)
            .saturating_add(1)
            .min(buffer.len() as u64) as usize;
        let read = platform::read_at(&reader, &mut buffer[..length], bytes)?;
        check_cancelled()?;
        if read as u64 > max_bytes - bytes {
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
            let (bytes, digest) = hash_file(fd, max_bytes, &cancelled)?;
            Ok(FileHash {
                bytes: bytes as f64,
                digest,
            })
        }),
        signal,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_cancellation_precedes_reader_admission() {
        let error = hash_file(-1, u64::MAX, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(error.status, "Cancelled");
        assert_eq!(error.reason, "SHA-256 operation aborted");
    }

    #[cfg(unix)]
    #[test]
    fn hash_crosses_buffer_boundaries_without_taking_or_seeking_the_borrowed_descriptor() {
        use std::fs::{self, File, OpenOptions};
        use std::io::{Read, Seek, SeekFrom, Write};
        use std::os::fd::AsRawFd;
        use std::path::PathBuf;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct Fixture {
            file: File,
            path: PathBuf,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.path);
            }
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fs-safe-native-hash-{}-{nonce}",
            std::process::id()
        ));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let mut fixture = Fixture { file, path };
        let payload: Vec<u8> = (0..65_537).map(|index| (index % 251) as u8).collect();
        fixture.file.write_all(&payload).unwrap();
        fixture.file.seek(SeekFrom::Start(2)).unwrap();
        let expected = "237356e18b503616912abb8ffaed3a72591e397d4ac294c4637917d48a3f529d";
        let cancelled = AtomicBool::new(false);
        for maximum in [payload.len() as u64, u64::MAX] {
            assert_eq!(
                hash_file(fixture.file.as_raw_fd(), maximum, &cancelled).unwrap(),
                (payload.len() as u64, expected.to_owned())
            );
            assert_eq!(fixture.file.stream_position().unwrap(), 2);
        }
        for maximum in [0, 65_536] {
            let error = hash_file(fixture.file.as_raw_fd(), maximum, &cancelled).unwrap_err();
            assert_eq!(error.status, "too-large");
            assert_eq!(error.reason, "SHA-256 input exceeds maxBytes");
            assert_eq!(fixture.file.stream_position().unwrap(), 2);
        }
        let mut next = [0];
        fixture.file.read_exact(&mut next).unwrap();
        assert_eq!(next[0], payload[2]);
        fixture.file.set_len(0).unwrap();
        assert_eq!(
            hash_file(fixture.file.as_raw_fd(), 0, &cancelled).unwrap(),
            (
                0,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned()
            )
        );
    }
}
