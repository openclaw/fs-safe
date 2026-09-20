use crate::{NativeResult, into_napi, native_error, validate_relative_path};
use crate::task::{NativeTask, cancellation};
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use std::sync::atomic::Ordering;

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

#[napi(js_name = "cloneTree")]
pub fn clone_tree(
    source_fd: Option<i32>,
    parent_fd: i32,
    name: String,
    concurrency: u32,
    signal: Option<AbortSignal>,
) -> Result<AsyncTask<NativeTask<()>>> {
    basename(&name).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    if !(1..=32).contains(&concurrency) {
        return Err(Error::new(
            Status::InvalidArg,
            "clone concurrency must be between 1 and 32",
        ));
    }
    let cancelled = cancellation(signal.as_ref());
    // Do not give AsyncTask the signal: early rejection would close the borrowed
    // descriptors while native workers still use them. JS waits for settlement.
    Ok(AsyncTask::new(NativeTask::new(move || {
        if cancelled.load(Ordering::Relaxed) {
            return Err(native_error("ABORT_ERR", "tree clone aborted"));
        }
        match source_fd {
            Some(source) => backend::clone_tree(
                source,
                parent_fd,
                &name,
                &cancelled,
                concurrency as usize,
            ),
            None => backend::create_source(parent_fd, &name),
        }
    })))
}
