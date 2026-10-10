use napi::{Env, Result, bindgen_prelude::BigInt};
use napi_derive::napi;
use crate::unix::{borrowed, nonnegative_fd, os_error};
use crate::{NativeResult, into_napi, native_error};

pub(crate) fn timespec(value: BigInt) -> NativeResult<rustix::fs::Timespec> {
    let (nanoseconds, lossless) = value.get_i128();
    if !lossless { return Err(native_error("EINVAL", "invalid copied timestamp")); }
    let seconds = nanoseconds.div_euclid(1_000_000_000).try_into()
        .map_err(|_| native_error("EINVAL", "copied timestamp is out of range"))?;
    Ok(rustix::fs::Timespec {
        tv_sec: seconds,
        tv_nsec: nanoseconds.rem_euclid(1_000_000_000) as _,
    })
}

pub(crate) fn file(fd: i32, times: &rustix::fs::Timestamps) -> NativeResult<()> {
    rustix::fs::futimens(borrowed(fd), times)
        .map_err(|error| os_error(error, "preserve copied file timestamps"))
}

pub(crate) fn link(fd: i32, times: &rustix::fs::Timestamps) -> NativeResult<()> {
    #[cfg(target_os = "linux")]
    let result = rustix::fs::utimensat(borrowed(fd), "", times,
        rustix::fs::AtFlags::EMPTY_PATH | rustix::fs::AtFlags::SYMLINK_NOFOLLOW);
    #[cfg(target_os = "macos")]
    let result = rustix::fs::futimens(borrowed(fd), times);
    result.map_err(|error| os_error(error, "preserve copied link timestamps"))
}

#[napi(js_name = "restoreCopyFileTimes")]
pub fn restore_copy_file_times(env: Env, fd: i32, atime_ns: BigInt, mtime_ns: BigInt) -> Result<()> {
    into_napi(env, (|| {
        nonnegative_fd(fd, "preserve copied file timestamps")?;
        file(fd, &rustix::fs::Timestamps {
            last_access: timespec(atime_ns)?, last_modification: timespec(mtime_ns)?,
        })
    })())
}
