use std::os::fd::{FromRawFd, IntoRawFd, OwnedFd};

use napi::Env;
use napi_derive::napi;

use crate::{NativeResult, into_napi, native_error};

#[napi(object)]
pub struct NativePipe {
    pub reader: i32,
    pub writer: i32,
    pub atomic_close_on_exec: bool,
}

fn last_error(operation: &str) -> crate::NativeError {
    let error = std::io::Error::last_os_error();
    // Preserve pipe/descriptor-flag failures through the N-API error's code.
    let code = match error.raw_os_error() {
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::ENFILE) => "ENFILE",
        Some(libc::ENOMEM) => "ENOMEM",
        Some(libc::EFAULT) => "EFAULT",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::EBADF) => "EBADF",
        Some(libc::EINTR) => "EINTR",
        Some(libc::ENOSYS) => "ENOSYS",
        Some(libc::EPERM) => "EPERM",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EAGAIN) => "EAGAIN",
        _ => "EIO",
    };
    native_error(code, format!("{operation}: {error}"))
}

fn create() -> NativeResult<NativePipe> {
    let mut fds = [-1; 2];
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    // SAFETY: pipe2 writes exactly two descriptors into the provided array.
    let result = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    #[cfg(target_os = "macos")]
    // SAFETY: pipe writes exactly two descriptors into the provided array.
    let result = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if result != 0 {
        return Err(last_error("create anonymous pipe"));
    }
    // SAFETY: a successful pipe call returned two distinct, uniquely owned fds.
    // Keep both owned until every fallible step succeeds, including Darwin flags.
    let reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    #[cfg(target_os = "macos")]
    for fd in fds {
        // SAFETY: both descriptors stay live and F_SETFD takes an integer flag.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(last_error("set anonymous pipe close-on-exec"));
        }
    }
    Ok(NativePipe {
        reader: reader.into_raw_fd(),
        writer: writer.into_raw_fd(),
        atomic_close_on_exec: !cfg!(target_os = "macos"),
    })
}

#[napi(js_name = "createPipe")]
pub fn create_pipe(env: Env) -> napi::Result<NativePipe> {
    into_napi(env, create())
}
