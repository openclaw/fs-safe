use crate::NativeResult;

pub(crate) struct ExactDirectoryObservation {
    pub dev: u64,
    pub ino: u64,
    pub real_path: String,
}

#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct ExactDirectoryFdObservation {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub nlink: u64,
    pub real_path: String,
}

#[cfg(unix)]
mod platform {
    use std::os::fd::AsRawFd;

    use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags, Stat};

    use super::{ExactDirectoryFdObservation, ExactDirectoryObservation};
    use crate::{NativeResult, native_error, unix::{borrowed, os_error}};

    #[cfg(target_os = "linux")]
    fn observation_open_flags() -> OFlags {
        OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
    }

    #[cfg(target_os = "macos")]
    fn observation_open_flags() -> OFlags {
        OFlags::from_bits_retain(libc::O_EVTONLY as u32)
            | OFlags::DIRECTORY
            | OFlags::NOFOLLOW
            | OFlags::CLOEXEC
    }

    #[cfg(target_os = "linux")]
    pub(super) fn canonical_path(fd: i32, link_count: u64) -> NativeResult<String> {
        // procfs appends " (deleted)" to an unlinked handle, but that suffix
        // is also a valid live basename. The retained handle's link count is
        // the unambiguous signal; never infer deletion from pathname text.
        if link_count == 0 {
            return Err(native_error(
                "path-mismatch",
                "observed directory was unlinked while resolving its handle",
            ));
        }
        let path = std::fs::read_link(format!("/proc/self/fd/{fd}"))
            .map_err(|error| {
                native_error(
                    "OBSERVATION_UNAVAILABLE",
                    format!("resolve observed directory handle: {error}"),
                )
            })?;
        let path = path.into_os_string().into_string().map_err(|_| {
            native_error(
                "OBSERVATION_UNAVAILABLE",
                "observed directory path is not valid UTF-8",
            )
        })?;
        Ok(path)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn canonical_path(fd: i32, _link_count: u64) -> NativeResult<String> {
        use std::ffi::CStr;

        let mut buffer = vec![0_i8; libc::PATH_MAX as usize];
        // SAFETY: buffer is writable for PATH_MAX bytes and fd stays open.
        if unsafe { libc::fcntl(fd, libc::F_GETPATH, buffer.as_mut_ptr()) } < 0 {
            return Err(native_error(
                "OBSERVATION_UNAVAILABLE",
                format!(
                    "resolve observed directory handle: {}",
                    std::io::Error::last_os_error(),
                ),
            ));
        }
        // SAFETY: F_GETPATH writes a NUL-terminated string on success.
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| {
                native_error(
                    "OBSERVATION_UNAVAILABLE",
                    "observed directory path is not valid UTF-8",
                )
            })
    }

    fn same_directory(left: &Stat, right: &Stat) -> bool {
        left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
            left.st_mode == right.st_mode && left.st_nlink == right.st_nlink
    }

    fn inspect_named_directory(path: &str) -> NativeResult<Stat> {
        rustix::fs::statat(CWD, path, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| os_error(error, "inspect observed directory name"))
    }

    fn observe_directory_fd_with(
        fd: i32,
        expected_path: &str,
        inspect_name: impl FnOnce() -> NativeResult<Stat>,
    ) -> NativeResult<ExactDirectoryFdObservation> {
        if fd < 0 {
            return Err(native_error("EBADF", "invalid observed directory descriptor"));
        }
        if !expected_path.starts_with('/') || expected_path.as_bytes().contains(&0) {
            return Err(native_error("EINVAL", "directory observation requires an absolute path"));
        }
        // The synchronous caller retains ownership. Never duplicate or close
        // this descriptor: closing another fd could release process locks.
        let directory = borrowed(fd);
        let before = rustix::fs::fstat(directory)
            .map_err(|error| os_error(error, "inspect retained directory observation"))?;
        if !FileType::from_raw_mode(before.st_mode).is_dir() {
            return Err(native_error("ENOTDIR", "observed descriptor is not a directory"));
        }
        if before.st_nlink == 0 {
            return Err(native_error("path-mismatch", "observed directory name changed"));
        }
        if canonical_path(fd, before.st_nlink as u64)? != expected_path {
            // No matching observation has begun. Let the caller apply its
            // ordered canonical-path admission to the selected descriptor.
            return Err(native_error("OBSERVATION_REDIRECTED", "observed directory has another canonical name"));
        }
        let named = inspect_name().map_err(|error| match error.status.as_str() {
            "ENOENT" | "ENOTDIR" | "ELOOP" => {
                native_error("path-mismatch", "observed directory name changed")
            }
            _ => error,
        })?;
        let after = rustix::fs::fstat(directory)
            .map_err(|error| os_error(error, "confirm retained directory observation"))?;
        if after.st_nlink == 0 || !same_directory(&before, &named) ||
            !same_directory(&before, &after) {
            return Err(native_error("path-mismatch", "observed directory identity changed"));
        }
        let real_path = canonical_path(fd, after.st_nlink as u64)?;
        if real_path != expected_path {
            return Err(native_error("path-mismatch", "observed directory name changed"));
        }
        #[cfg(target_os = "linux")]
        if real_path.ends_with(" (deleted)") {
            // An attacker could rename a literal-suffix directory before
            // unlinking it; disambiguate procfs text after the final read.
            let confirmed = rustix::fs::fstat(directory)
                .map_err(|error| os_error(error, "confirm retained directory link count"))?;
            if confirmed.st_nlink == 0 || !same_directory(&after, &confirmed) {
                return Err(native_error("path-mismatch", "observed directory identity changed"));
            }
        }
        Ok(ExactDirectoryFdObservation {
            dev: after.st_dev as u64,
            ino: after.st_ino as u64,
            mode: after.st_mode as u32,
            nlink: after.st_nlink as u64,
            real_path,
        })
    }

    pub(super) fn observe_directory_fd(
        fd: i32,
        expected_path: &str,
    ) -> NativeResult<ExactDirectoryFdObservation> {
        observe_directory_fd_with(fd, expected_path, || inspect_named_directory(expected_path))
    }

    #[allow(clippy::unnecessary_cast)] // stat field widths differ between Linux and Darwin.
    pub(super) fn staged_directory_matches(fd: i32, path: &str, dev: u64, ino: u64) -> NativeResult<bool> {
        if fd < 0 { return Err(native_error("EBADF", "invalid staged directory descriptor")); }
        if !path.starts_with('/') || path.as_bytes().contains(&0) {
            return Err(native_error("EINVAL", "staged directory requires an absolute path"));
        }
        // The caller retains the descriptor; verify its named and canonical
        // identity without reopening the directory or closing a borrowed fd.
        let named = inspect_named_directory(path)?;
        let retained = rustix::fs::fstat(borrowed(fd))
            .map_err(|error| os_error(error, "inspect staged directory descriptor"))?;
        let matches = FileType::from_raw_mode(named.st_mode).is_dir()
            && FileType::from_raw_mode(retained.st_mode).is_dir()
            && retained.st_nlink != 0
            && named.st_dev as u64 == dev && named.st_ino as u64 == ino
            && retained.st_dev as u64 == dev && retained.st_ino as u64 == ino;
        if !matches || canonical_path(fd, retained.st_nlink as u64)? != path { return Ok(false); }
        #[cfg(target_os = "linux")]
        if path.ends_with(" (deleted)") {
            let after = rustix::fs::fstat(borrowed(fd))
                .map_err(|error| os_error(error, "confirm staged directory link count"))?;
            if after.st_nlink == 0 || !FileType::from_raw_mode(after.st_mode).is_dir()
                || after.st_dev as u64 != dev || after.st_ino as u64 != ino { return Ok(false); }
        }
        Ok(true)
    }

    pub(super) fn observe_directory(path: &str) -> NativeResult<ExactDirectoryObservation> {
        let directory = rustix::fs::open(path, observation_open_flags(), Mode::empty())
            .map_err(|error| os_error(error, "open directory observation"))?;
        let stat = rustix::fs::fstat(&directory)
            .map_err(|error| os_error(error, "inspect directory observation"))?;
        if !FileType::from_raw_mode(stat.st_mode).is_dir() {
            return Err(native_error("ENOTDIR", "observed path is not a directory"));
        }
        let real_path = canonical_path(directory.as_raw_fd(), stat.st_nlink as u64)?;
        #[cfg(target_os = "linux")]
        if real_path.ends_with(" (deleted)") {
            // The suffix alone is ambiguous. Recheck the same retained handle
            // after reading procfs so an unlink racing the first fstat cannot
            // masquerade as a live literal basename.
            let confirmed = rustix::fs::fstat(&directory)
                .map_err(|error| os_error(error, "confirm directory observation"))?;
            if confirmed.st_nlink == 0 {
                return Err(native_error(
                    "path-mismatch",
                    "observed directory was unlinked while resolving its handle",
                ));
            }
        }
        Ok(ExactDirectoryObservation {
            dev: stat.st_dev as u64,
            ino: stat.st_ino as u64,
            real_path,
        })
    }

    #[cfg(test)]
    mod tests {
        include!("directory_observation_tests.rs");
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES,
    };

    use super::ExactDirectoryObservation;
    use crate::{
        NativeResult, native_error,
        windows::{observe_directory_identity, open_existing_handle, wide_absolute_path, win_error},
    };

    pub(super) fn canonical_path(handle: windows_sys::Win32::Foundation::HANDLE, input: &str) -> NativeResult<String> {
        crate::windows_canonical_path::canonical_path(handle, input, |error| {
            if let Some(code) = error.errno {
                native_error("OBSERVATION_UNAVAILABLE",
                    format!("resolve observed directory path: Windows error {code}"))
            } else if error.status == "ENOTSUP" {
                native_error("OBSERVATION_UNAVAILABLE", "observed directory path is not valid UTF-16")
            } else { error }
        })
    }

    #[test]
    fn invalid_handle_preserves_observation_error() {
        let error = canonical_path(windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE, r"C:\").unwrap_err();
        assert_eq!(error.status, "OBSERVATION_UNAVAILABLE");
        assert_eq!(error.reason, "resolve observed directory path: Windows error 6");
        assert_eq!(error.errno, None);
    }

    pub(super) fn observe_directory(path: &str) -> NativeResult<ExactDirectoryObservation> {
        if path.contains('\0') {
            return Err(native_error("EINVAL", "directory path contains a NUL byte"));
        }
        let wide = wide_absolute_path(path);
        let handle = open_existing_handle(
            &wide,
            FILE_READ_ATTRIBUTES,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            |code| win_error(code, "open directory observation"),
        )?;
        let (dev, ino) = observe_directory_identity(handle.0)?;
        let real_path = canonical_path(handle.0, path)?;
        Ok(ExactDirectoryObservation {
            dev: u64::from(dev),
            ino,
            real_path,
        })
    }

}

pub(crate) fn observe_directory(path: &str) -> NativeResult<ExactDirectoryObservation> {
    platform::observe_directory(path)
}

#[cfg(unix)]
pub(crate) fn canonical_unix_directory(fd: i32, nlink: u64) -> NativeResult<String> {
    platform::canonical_path(fd, nlink)
}

#[cfg(windows)]
pub(crate) fn canonical_windows_directory(handle: windows_sys::Win32::Foundation::HANDLE, input: &str) -> NativeResult<String> {
    platform::canonical_path(handle, input)
}

#[cfg(unix)]
pub(crate) fn observe_directory_fd(
    fd: i32,
    expected_path: &str,
) -> NativeResult<ExactDirectoryFdObservation> {
    platform::observe_directory_fd(fd, expected_path)
}

#[cfg(unix)]
pub(crate) fn staged_directory_matches(fd: i32, path: &str, dev: u64, ino: u64) -> NativeResult<bool> {
    platform::staged_directory_matches(fd, path, dev, ino)
}
