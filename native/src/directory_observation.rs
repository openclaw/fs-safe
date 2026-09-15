use crate::NativeResult;

pub(crate) struct ExactDirectoryObservation {
    pub dev: u64,
    pub ino: u64,
    pub real_path: String,
}

#[cfg(unix)]
mod platform {
    use std::os::fd::AsRawFd;

    use rustix::fs::{FileType, Mode, OFlags};

    use super::ExactDirectoryObservation;
    use crate::{NativeResult, native_error, unix::os_error};

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
    fn canonical_path(fd: i32, link_count: u64) -> NativeResult<String> {
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
    fn canonical_path(fd: i32, _link_count: u64) -> NativeResult<String> {
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
}

#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        GetFinalPathNameByHandleW, OPEN_EXISTING,
    };

    use super::ExactDirectoryObservation;
    use crate::{
        NativeResult, native_error,
        windows::{OwnedHandle, handle_identity, handle_is_reparse, win_error},
    };

    fn wide_path(path: &str) -> NativeResult<Vec<u16>> {
        let normalized = path.replace('/', r"\");
        let opened = if normalized.starts_with(r"\\?\") || normalized.starts_with(r"\\.\") {
            normalized
        } else if let Some(unc) = normalized.strip_prefix(r"\\") {
            format!(r"\\?\UNC\{unc}")
        } else {
            format!(r"\\?\{normalized}")
        };
        let mut wide: Vec<u16> = std::ffi::OsStr::new(&opened).encode_wide().collect();
        if wide.contains(&0) {
            return Err(native_error("EINVAL", "directory path contains a NUL byte"));
        }
        wide.push(0);
        Ok(wide)
    }

    fn canonical_path(handle: windows_sys::Win32::Foundation::HANDLE) -> NativeResult<String> {
        // The query and copy both address the same retained directory handle.
        let needed = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
        if needed == 0 {
            return Err(native_error(
                "OBSERVATION_UNAVAILABLE",
                format!(
                    "size observed directory path: Windows error {}",
                    unsafe { GetLastError() },
                ),
            ));
        }
        let mut buffer = vec![0_u16; needed as usize + 1];
        let written = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        };
        if written == 0 || written as usize >= buffer.len() {
            return Err(native_error(
                "OBSERVATION_UNAVAILABLE",
                format!(
                    "resolve observed directory path: Windows error {}",
                    unsafe { GetLastError() },
                ),
            ));
        }
        let path = String::from_utf16(&buffer[..written as usize]).map_err(|_| {
            native_error(
                "OBSERVATION_UNAVAILABLE",
                "observed directory path is not valid UTF-16",
            )
        })?;
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{path}"));
        }
        Ok(path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned())
    }

    pub(super) fn observe_directory(path: &str) -> NativeResult<ExactDirectoryObservation> {
        let path = wide_path(path)?;
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(win_error(unsafe { GetLastError() }, "open directory observation"));
        }
        let handle = OwnedHandle(handle);
        if handle_is_reparse(handle.0)? {
            return Err(native_error("ELOOP", "observed directory is a reparse point"));
        }
        let (dev, ino, is_directory) = handle_identity(handle.0)?;
        if !is_directory {
            return Err(native_error("ENOTDIR", "observed path is not a directory"));
        }
        let real_path = canonical_path(handle.0)?;
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
