use napi::bindgen_prelude::*;
use napi_derive::napi;
use crate::{NativeResult, into_napi};
use crate::unix::os_error;

fn lease_command(fd: i32, command: i32, value: i32) -> NativeResult<i32> {
    // The caller owns this descriptor and keeps it open through the call.
    let result = unsafe { libc::fcntl(fd, command, value) };
    if result < 0 {
        return Err(os_error(rustix::io::Errno::last_os_error(), "file write lease"));
    }
    Ok(result)
}

#[napi(js_name = "tryAcquireWriteLease")]
pub fn try_acquire_write_lease(env: Env, fd: i32) -> Result<bool> {
    into_napi(env, match lease_command(fd, libc::F_SETLEASE, libc::F_WRLCK) {
        Ok(_) => Ok(true),
        Err(error) if error.status == "EAGAIN" || error.status == "EBUSY" => Ok(false),
        Err(error) => Err(error),
    })
}

#[napi(js_name = "isFileWriteLeaseHeld")]
pub fn is_file_write_lease_held(env: Env, fd: i32) -> Result<bool> {
    into_napi(env, lease_command(fd, libc::F_GETLEASE, 0).map(|value| value == libc::F_WRLCK))
}

#[napi(js_name = "releaseFileWriteLease")]
pub fn release_file_write_lease(env: Env, fd: i32) -> Result<()> {
    into_napi(env, (|| {
        match lease_command(fd, libc::F_SETLEASE, libc::F_UNLCK) {
            Ok(_) => Ok(()),
            // Only after attempting unlock can F_UNLCK prove a completed break;
            // before it, that value can describe a still-blocked writer's request.
            Err(error) if error.status == "EAGAIN" && lease_command(fd, libc::F_GETLEASE, 0)? == libc::F_UNLCK => Ok(()),
            Err(error) => Err(error),
        }
    })())
}
