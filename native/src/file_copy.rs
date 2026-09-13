use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, JsError, Result, Status};
use napi_derive::napi;
use rustix::fs::{FileType, Mode, OFlags};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::unix::{
    borrowed, clone_file_exclusive_with_sync, os_error, remove_matching_child,
    validate_child_basename,
};
use crate::{NativeResult, native_error};

#[napi(object)]
pub struct NativeFileCopyResult {
    pub fd: i32,
    pub method: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum CloneMode {
    Never,
    Auto,
    Always,
}

// The result retains both cleanup identity and the parent until the JS thread
// accepts its descriptor. This also handles an abort after compute completes.
pub struct CreatedCopy {
    parent: OwnedFd,
    name: String,
    target: Option<OwnedFd>,
    method: &'static str,
    error: Option<Error<String>>,
}

impl CreatedCopy {
    fn fd(&self) -> &OwnedFd {
        self.target.as_ref().unwrap()
    }

    fn release(mut self) -> NativeFileCopyResult {
        let (error_code, error_message) = self.error.take().map_or((None, None), |error| {
            (Some(error.status), Some(error.reason))
        });
        NativeFileCopyResult {
            fd: self.target.take().unwrap().into_raw_fd(),
            method: self.method.to_owned(),
            error_code,
            error_message,
        }
    }
}

impl Drop for CreatedCopy {
    fn drop(&mut self) {
        if let Some(target) = &self.target {
            let _ = remove_matching_child(self.parent.as_raw_fd(), &self.name, target.as_raw_fd());
        }
    }
}

pub struct FileCopyTask {
    source_fd: i32,
    parent_fd: i32,
    name: String,
    clone_mode: CloneMode,
    max_bytes: u64,
    cancelled: Arc<AtomicBool>,
    sync: bool,
}

impl Task for FileCopyTask {
    type Output = NativeResult<CreatedCopy>;
    type JsValue = NativeFileCopyResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.copy())
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let mut created =
            output.map_err(|error| Error::from(JsError::from(error).into_unknown(env)))?;
        if created.error.is_none() {
            created.error = self.check_cancelled().err();
        }
        // Even a failed transfer hands its descriptor to the staged owner. That
        // owner can report failed cleanup instead of losing the recovery receipt.
        Ok(created.release())
    }
}

impl FileCopyTask {
    fn check_cancelled(&self) -> NativeResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(native_error("Cancelled", "file copy aborted"));
        }
        Ok(())
    }

    fn check_size(&self, fd: &OwnedFd) -> NativeResult<()> {
        let stat = rustix::fs::fstat(fd).map_err(|error| os_error(error, "inspect copied file"))?;
        let bytes = u64::try_from(stat.st_size)
            .map_err(|_| native_error("EINVAL", "copy file has a negative size"))?;
        if !FileType::from_raw_mode(stat.st_mode).is_file() {
            return Err(native_error("EINVAL", "copy requires a regular file"));
        }
        if bytes > self.max_bytes {
            return Err(native_error("too-large", "copy input exceeds maxBytes"));
        }
        Ok(())
    }

    fn copy(&self) -> NativeResult<CreatedCopy> {
        self.check_cancelled()?;
        let source = rustix::io::fcntl_dupfd_cloexec(borrowed(self.source_fd), 0)
            .map_err(|error| os_error(error, "retain copy source"))?;
        let parent = rustix::io::fcntl_dupfd_cloexec(borrowed(self.parent_fd), 0)
            .map_err(|error| os_error(error, "retain copy parent"))?;
        self.check_size(&source)?;
        self.check_cancelled()?;
        let cloned = if self.clone_mode == CloneMode::Never {
            None
        } else {
            match clone_file_exclusive_with_sync(
                source.as_raw_fd(),
                parent.as_raw_fd(),
                &self.name,
                false,
            ) {
                Ok(fd) => {
                    // SAFETY: clone returned a newly owned descriptor.
                    Some(unsafe { OwnedFd::from_raw_fd(fd) })
                }
                Err(error) if self.clone_mode == CloneMode::Auto && unsupported(&error.status) => {
                    None
                }
                Err(error) => return Err(error),
            }
        };
        let mut created = if let Some(target) = cloned {
            CreatedCopy {
                parent,
                name: self.name.clone(),
                target: Some(target),
                method: "clone",
                error: None,
            }
        } else {
            self.check_cancelled()?;
            let target = rustix::fs::openat(
                &parent,
                self.name.as_str(),
                OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_bits_retain(0o600),
            )
            .map_err(|error| os_error(error, "create copy stage"))?;
            CreatedCopy {
                parent,
                name: self.name.clone(),
                target: Some(target),
                method: "copy",
                error: None,
            }
        };
        created.error = (|| {
            if created.method != "clone" {
                created.method = self.copy_contents(&source, created.fd())?;
            }
            self.check_cancelled()?;
            self.check_size(created.fd())?;
            rustix::fs::fchmod(created.fd(), Mode::from_bits_retain(0o600))
                .map_err(|error| os_error(error, "set copied file mode"))?;
            if self.sync {
                self.check_cancelled()?;
                rustix::fs::fsync(created.fd())
                    .map_err(|error| os_error(error, "sync copied file"))?;
            }
            self.check_cancelled()
        })()
        .err();
        Ok(created)
    }

    fn copy_contents(&self, source: &OwnedFd, target: &OwnedFd) -> NativeResult<&'static str> {
        let mut offset = 0_u64;
        #[cfg(target_os = "linux")]
        if self.clone_mode == CloneMode::Auto {
            offset = match copy_file_ranges(
                source.as_raw_fd(),
                target.as_raw_fd(),
                self.max_bytes,
                || self.check_cancelled(),
            )? {
                RangeCopyOutcome::Complete(_) => return Ok("copy-file-range"),
                RangeCopyOutcome::Unsupported { offset, .. } => offset,
            };
        }
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            self.check_cancelled()?;
            let length = self.read_length(offset, buffer.len());
            let bytes = match rustix::io::pread(source, &mut buffer[..length], offset) {
                Ok(bytes) => bytes,
                Err(rustix::io::Errno::INTR) => continue,
                Err(error) => return Err(os_error(error, "read copy source")),
            };
            self.check_cancelled()?;
            if bytes as u64 > self.max_bytes - offset {
                return Err(native_error("too-large", "copy input exceeds maxBytes"));
            }
            if bytes == 0 {
                return Ok("copy");
            }
            let mut written = 0;
            while written < bytes {
                self.check_cancelled()?;
                match rustix::io::pwrite(target, &buffer[written..bytes], offset + written as u64) {
                    Ok(0) => return Err(native_error("EIO", "copy write made no progress")),
                    Ok(bytes) => written += bytes,
                    Err(rustix::io::Errno::INTR) => continue,
                    Err(error) => return Err(os_error(error, "write copy stage")),
                }
            }
            offset += bytes as u64;
        }
    }

    fn read_length(&self, offset: u64, capacity: usize) -> usize {
        (self.max_bytes - offset)
            .saturating_add(1)
            .min(capacity as u64) as usize
    }
}

fn unsupported(code: &str) -> bool {
    matches!(code, "ENOTSUP" | "ENOSYS" | "EXDEV" | "EINVAL")
}

#[cfg(target_os = "linux")]
pub(crate) enum RangeCopyOutcome {
    Complete(u64),
    Unsupported { offset: u64, error: Error<String> },
}

#[cfg(target_os = "linux")]
pub(crate) fn copy_file_ranges(
    source_fd: i32,
    target_fd: i32,
    max_bytes: u64,
    check_cancelled: impl Fn() -> NativeResult<()>,
) -> NativeResult<RangeCopyOutcome> {
    let mut offset = 0_u64;
    loop {
        check_cancelled()?;
        let length = (max_bytes - offset).saturating_add(1).min(16 * 1024 * 1024) as usize;
        let mut target_offset = offset;
        let copied = rustix::fs::copy_file_range(
            borrowed(source_fd),
            Some(&mut offset),
            borrowed(target_fd),
            Some(&mut target_offset),
            length,
        );
        check_cancelled()?;
        match copied {
            Ok(_) if offset > max_bytes => {
                return Err(native_error("too-large", "copy input exceeds maxBytes"));
            }
            Ok(0) => return Ok(RangeCopyOutcome::Complete(offset)),
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => {
                let error = os_error(error, "copy_file_range");
                return if unsupported(&error.status) {
                    Ok(RangeCopyOutcome::Unsupported { offset, error })
                } else {
                    Err(error)
                };
            }
        }
    }
}

#[napi(js_name = "copyFileExclusive")]
pub fn copy_file_exclusive(
    source_fd: i32,
    parent_fd: i32,
    basename: String,
    clone_mode: String,
    max_bytes: Option<f64>,
    signal: Option<AbortSignal>,
    sync: bool,
) -> Result<AsyncTask<FileCopyTask>> {
    validate_child_basename(&basename)
        .map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    let clone_mode = match clone_mode.as_str() {
        "never" => CloneMode::Never,
        "auto" => CloneMode::Auto,
        "always" => CloneMode::Always,
        _ => return Err(Error::new(Status::InvalidArg, "invalid copy clone mode")),
    };
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
    // Keep settlement under this task: every created descriptor, including a
    // canceled transfer, must pass through resolve to reach its cleanup owner.
    Ok(AsyncTask::new(FileCopyTask {
        source_fd,
        parent_fd,
        name: basename,
        clone_mode,
        max_bytes,
        cancelled,
        sync,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        path: PathBuf,
        source: File,
        parent: File,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("fs-safe-copy-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("source"), b"copy source").unwrap();
            let source = OpenOptions::new()
                .read(true)
                .write(true)
                .open(path.join("source"))
                .unwrap();
            let parent = File::open(&path).unwrap();
            Self {
                path,
                source,
                parent,
            }
        }

        fn task(&self, clone_mode: CloneMode, max_bytes: u64) -> FileCopyTask {
            FileCopyTask {
                source_fd: self.source.as_raw_fd(),
                parent_fd: self.parent.as_raw_fd(),
                name: "stage".to_owned(),
                clone_mode,
                max_bytes,
                cancelled: Arc::new(AtomicBool::new(false)),
                sync: false,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.path).unwrap();
        }
    }

    #[test]
    fn transfer_preserves_contents_source_position_and_existing_destinations() {
        for clone_mode in [CloneMode::Never, CloneMode::Auto, CloneMode::Always] {
            let mut fixture = Fixture::new();
            let contents = (0..150_001)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            fixture.source.write_all(&contents).unwrap();
            fixture.source.seek(SeekFrom::Start(7)).unwrap();
            fixture
                .source
                .set_permissions(fs::Permissions::from_mode(0o777))
                .unwrap();
            let task = fixture.task(clone_mode, contents.len() as u64);
            let created = match task.copy() {
                Ok(created) => created,
                Err(error) if clone_mode == CloneMode::Always && unsupported(&error.status) => {
                    assert!(!fixture.path.join("stage").exists());
                    continue;
                }
                Err(error) => panic!("copy failed: {error}"),
            };
            if clone_mode == CloneMode::Never {
                assert_eq!(created.method, "copy");
            } else if clone_mode == CloneMode::Always {
                assert_eq!(created.method, "clone");
            }
            assert!(
                rustix::io::fcntl_getfd(&created.parent)
                    .unwrap()
                    .contains(rustix::io::FdFlags::CLOEXEC)
            );
            assert!(
                rustix::io::fcntl_getfd(created.fd())
                    .unwrap()
                    .contains(rustix::io::FdFlags::CLOEXEC)
            );
            assert_eq!(fs::read(fixture.path.join("stage")).unwrap(), contents);
            assert_eq!(fixture.source.stream_position().unwrap(), 7);
            assert_eq!(
                fs::metadata(fixture.path.join("stage"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(task.copy().err().unwrap().status, "EEXIST");
            assert_eq!(fs::read(fixture.path.join("stage")).unwrap(), contents);
            drop(created);
            assert!(!fixture.path.join("stage").exists());
        }
    }

    #[test]
    fn rejects_retired_clone_mode_before_starting_work() {
        let error = copy_file_exclusive(
            i32::MAX,
            i32::MAX,
            "stage".to_owned(),
            "require".to_owned(),
            None,
            None,
            false,
        )
        .err()
        .expect("retired clone mode must be rejected");
        assert_eq!(error.status, Status::InvalidArg);
    }

    #[test]
    fn source_growth_is_bounded_during_transfer_and_failed_stages_are_removed() {
        for clone_mode in [CloneMode::Never, CloneMode::Auto] {
            let mut fixture = Fixture::new();
            let task = fixture.task(clone_mode, 11);
            let source = rustix::io::dup(borrowed(task.source_fd)).unwrap();
            task.check_size(&source).unwrap();
            fixture.source.seek(SeekFrom::End(0)).unwrap();
            fixture.source.write_all(b" grew").unwrap();
            let created = CreatedCopy {
                parent: rustix::io::dup(borrowed(task.parent_fd)).unwrap(),
                name: task.name.clone(),
                target: Some(
                    OpenOptions::new()
                        .read(true)
                        .write(true)
                        .create_new(true)
                        .open(fixture.path.join("stage"))
                        .unwrap()
                        .into(),
                ),
                method: "copy",
                error: None,
            };
            assert_eq!(
                task.copy_contents(&source, created.fd())
                    .err()
                    .unwrap()
                    .status,
                "too-large"
            );
            drop(created);
            assert!(!fixture.path.join("stage").exists());
            assert_eq!(task.copy().err().unwrap().status, "too-large");
            assert!(!fixture.path.join("stage").exists());
            let mut task = fixture.task(clone_mode, u64::MAX);
            task.source_fd = i32::MAX;
            assert_eq!(task.copy().err().unwrap().status, "EBADF");
            assert!(!fixture.path.join("stage").exists());
        }
    }

    #[test]
    fn unsettled_copy_cleanup_retains_its_parent_and_preserves_substituted_files() {
        let mut fixture = Fixture::new();
        let task = fixture.task(CloneMode::Never, u64::MAX);
        let created = task.copy().unwrap();
        let original_path = fixture.path.clone();
        let moved_path = original_path.with_extension("moved");
        fs::rename(&original_path, &moved_path).unwrap();
        fixture.path = moved_path;
        fs::create_dir(&original_path).unwrap();
        fs::write(original_path.join("stage"), b"different parent").unwrap();
        drop(created);
        assert!(!fixture.path.join("stage").exists());
        assert_eq!(
            fs::read(original_path.join("stage")).unwrap(),
            b"different parent"
        );
        let created = task.copy().unwrap();
        fs::rename(fixture.path.join("stage"), fixture.path.join("owned")).unwrap();
        fs::write(fixture.path.join("stage"), b"different identity").unwrap();
        drop(created);
        assert_eq!(
            fs::read(fixture.path.join("stage")).unwrap(),
            b"different identity"
        );
        assert_eq!(
            fs::read(fixture.path.join("owned")).unwrap(),
            b"copy source"
        );
        fs::remove_dir_all(original_path).unwrap();
    }
}
