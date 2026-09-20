use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "linux")]
use crate::copy_linux::copy_contents;
#[cfg(windows)]
use crate::copy_windows::copy_contents;
use crate::{NativeResult, native_error};
use crate::task::{NativeTask, cancellation};

pub(crate) fn check_cancelled(cancelled: &AtomicBool) -> NativeResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(native_error("ABORT_ERR", "file copy aborted"))
    } else {
        Ok(())
    }
}

#[napi(js_name = "copyFileContents")]
pub fn copy_file_contents(
    source_fd: i32,
    target_fd: i32,
    signal: Option<AbortSignal>,
) -> AsyncTask<NativeTask<()>> {
    let cancelled = cancellation(signal.as_ref());
    // The caller owns both descriptors until settlement. Never let napi reject
    // early while an admitted read, write, or final size update still uses them.
    AsyncTask::new(NativeTask::new(move || {
        copy_contents(source_fd, target_fd, &cancelled)
    }))
}
