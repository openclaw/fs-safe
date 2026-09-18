use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, JsError, Result};
use napi_derive::napi;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[cfg(target_os = "linux")]
use crate::copy_linux::copy_contents;
#[cfg(windows)]
use crate::copy_windows::copy_contents;
use crate::{NativeResult, native_error};

pub struct CopyFileContentsTask {
    source_fd: i32,
    target_fd: i32,
    cancelled: Arc<AtomicBool>,
}

pub(crate) fn check_cancelled(cancelled: &AtomicBool) -> NativeResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(native_error("ABORT_ERR", "file copy aborted"))
    } else {
        Ok(())
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
