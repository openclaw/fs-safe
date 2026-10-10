use napi::{Env, Error, Result, Status};
use napi_derive::napi;

fn close(fd: i32) -> std::result::Result<(), rustix::io::Errno> {
    if fd < 0 {
        return Err(rustix::io::Errno::BADF);
    }
    // SAFETY: the caller transfers an addon-owned fd exactly once. An error
    // consumes ownership too; retrying could close a newly reused descriptor.
    unsafe { rustix::io::try_close(fd) }
}

#[napi(js_name = "closeOwnedFd")]
pub fn close_owned_fd(env: Env, fd: i32) -> Result<()> {
    close(fd).map_err(|error| {
        let code = if error == rustix::io::Errno::BADF { "EBADF" } else { "EIO" };
        let message = format!("close native-owned file descriptor: {error}");
        match env.throw_error(&message, Some(code)) {
            Ok(()) => Error::new(Status::PendingException, message),
            Err(error) => error,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::IntoRawFd;

    #[test]
    fn closes_an_owned_descriptor() {
        let path = crate::test_support::temp_path("freebsd-close");
        let fd = std::fs::File::create_new(&path).unwrap().into_raw_fd();
        close(fd).unwrap();
        // SAFETY: F_GETFD only inspects the descriptor table; no allocation intervenes.
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_negative_descriptors() {
        assert_eq!(close(-1), Err(rustix::io::Errno::BADF));
    }
}
