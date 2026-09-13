use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, JsError, Result};
use napi_derive::napi;
use rustix::fs::{FileType, OFlags};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::unix::{borrowed, os_error};
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
    let source = borrowed(source_fd);
    let target = borrowed(target_fd);
    let source_stat =
        rustix::fs::fstat(source).map_err(|error| os_error(error, "inspect copy source"))?;
    let target_stat =
        rustix::fs::fstat(target).map_err(|error| os_error(error, "inspect copy target"))?;
    if !FileType::from_raw_mode(source_stat.st_mode).is_file()
        || !FileType::from_raw_mode(target_stat.st_mode).is_file()
        || (source_stat.st_dev == target_stat.st_dev && source_stat.st_ino == target_stat.st_ino)
    {
        return Err(native_error(
            "EINVAL",
            "file copy requires distinct ordinary files",
        ));
    }
    if rustix::fs::fcntl_getfl(target)
        .map_err(|error| os_error(error, "inspect copy target flags"))?
        .contains(OFlags::APPEND)
    {
        return Err(native_error(
            "EINVAL",
            "file copy requires a non-append target",
        ));
    }
    // Only an empty destination makes unwritten ranges read as zeros. Existing
    // targets retain the Windows adapter's dense overwrite and untouched tail.
    let sparse = target_stat.st_size == 0;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut offset = 0_u64;
    loop {
        check_cancelled(cancelled)?;
        let read = match rustix::io::pread(source, &mut buffer, offset) {
            Ok(read) => read,
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(os_error(error, "read copy source")),
        };
        check_cancelled(cancelled)?;
        if read == 0 {
            if sparse {
                rustix::fs::ftruncate(target, offset)
                    .map_err(|error| os_error(error, "size copied file"))?;
            }
            return check_cancelled(cancelled);
        }
        let (mut written, end) = if sparse {
            match buffer[..read].iter().position(|byte| *byte != 0) {
                Some(start) => (
                    start,
                    buffer[..read].iter().rposition(|byte| *byte != 0).unwrap() + 1,
                ),
                None => (read, read),
            }
        } else {
            (0, read)
        };
        while written < end {
            check_cancelled(cancelled)?;
            match rustix::io::pwrite(target, &buffer[written..end], offset + written as u64) {
                Ok(0) => return Err(native_error("EIO", "file copy write made no progress")),
                Ok(bytes) => written += bytes,
                Err(rustix::io::Errno::INTR) => continue,
                Err(error) => return Err(os_error(error, "write copied file")),
            }
        }
        offset += read as u64;
    }
}

impl Task for CopyFileContentsTask {
    type Output = NativeResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(copy_contents(
            self.source_fd,
            self.target_fd,
            &self.cancelled,
        ))
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
    // The caller owns both descriptors until settlement. Never let napi reject
    // early while an admitted read, write, or final size update still uses them.
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
    use std::io::{Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sparse_transfer_preserves_bytes_length_and_borrowed_offsets() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("fs-safe-sparse-{}-{nonce}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        for size in [0, 1, 4 * 1024 * 1024 + 17] {
            let source_path = directory.join(format!("source-{size}"));
            let target_path = directory.join(format!("target-{size}"));
            let mut source = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&source_path)
                .unwrap();
            source.set_len(size).unwrap();
            if size > 1 {
                source.seek(SeekFrom::Start(1024 * 1024 + 3)).unwrap();
                source.write_all(b"ordinary sparse payload").unwrap();
            }
            let mut target = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&target_path)
                .unwrap();
            source.seek(SeekFrom::Start(7)).unwrap();
            target.seek(SeekFrom::Start(11)).unwrap();
            copy_contents(
                source.as_raw_fd(),
                target.as_raw_fd(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(source.stream_position().unwrap(), 7);
            assert_eq!(target.stream_position().unwrap(), 11);
            assert_eq!(target.metadata().unwrap().len(), size);
            assert_eq!(
                fs::read(&source_path).unwrap(),
                fs::read(&target_path).unwrap()
            );
            if size > 1 && source.metadata().unwrap().blocks() * 512 < size / 2 {
                assert!(target.metadata().unwrap().blocks() * 512 < size / 2);
            }
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn existing_target_is_overwritten_densely_without_losing_its_tail() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("fs-safe-copy-tail-{}-{nonce}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let source_path = directory.join("source");
        let target_path = directory.join("target");
        fs::write(&source_path, b"a\0\0b\0").unwrap();
        fs::write(&target_path, b"previous-tail").unwrap();
        let source = File::open(source_path).unwrap();
        let target = OpenOptions::new().write(true).open(&target_path).unwrap();
        copy_contents(
            source.as_raw_fd(),
            target.as_raw_fd(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(fs::read(&target_path).unwrap(), b"a\0\0b\0ous-tail");
        copy_contents(
            source.as_raw_fd(),
            target.as_raw_fd(),
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(fs::read(target_path).unwrap(), b"a\0\0b\0ous-tail");
        fs::remove_dir_all(directory).unwrap();
    }
}
