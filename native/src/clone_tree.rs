use crate::{NativeResult, into_napi, native_error, validate_relative_path};
use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Error, JsError, Result, Status};
use napi_derive::napi;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[cfg(unix)]
use crate::clone_unix as backend;
#[cfg(windows)]
use crate::clone_windows as backend;

fn basename(name: &str) -> NativeResult<()> {
    validate_relative_path(name, false)?;
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(native_error(
            "EINVAL",
            "clone destination must be a direct-child basename",
        ));
    }
    Ok(())
}

#[napi(js_name = "probeTreeClone")]
pub fn probe_tree_clone(env: Env, parent_fd: i32) -> Result<Option<String>> {
    into_napi(env, backend::probe(parent_fd))
}

pub struct CloneTreeTask {
    source_fd: Option<i32>,
    parent_fd: i32,
    basename: String,
    concurrency: usize,
    cancelled: Arc<AtomicBool>,
}

impl Task for CloneTreeTask {
    type Output = NativeResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(Err(native_error("ABORT_ERR", "tree clone aborted")));
        }
        Ok(match self.source_fd {
            Some(source) => backend::clone_tree(
                source,
                self.parent_fd,
                &self.basename,
                &self.cancelled,
                self.concurrency,
            ),
            None => backend::create_source(self.parent_fd, &self.basename),
        })
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<()> {
        output.map_err(|error| Error::from(JsError::from(error).into_unknown(env)))
    }
}

#[napi(js_name = "cloneTree")]
pub fn clone_tree(
    source_fd: Option<i32>,
    parent_fd: i32,
    name: String,
    concurrency: u32,
    signal: Option<AbortSignal>,
) -> Result<AsyncTask<CloneTreeTask>> {
    basename(&name).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    if !(1..=32).contains(&concurrency) {
        return Err(Error::new(
            Status::InvalidArg,
            "clone concurrency must be between 1 and 32",
        ));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let flag = Arc::clone(&cancelled);
        signal.on_abort(move || flag.store(true, Ordering::Relaxed));
    }
    // Do not give AsyncTask the signal: early rejection would close the borrowed
    // descriptors while native workers still use them. JS waits for settlement.
    Ok(AsyncTask::new(CloneTreeTask {
        source_fd,
        parent_fd,
        basename: name,
        concurrency: concurrency as usize,
        cancelled,
    }))
}
