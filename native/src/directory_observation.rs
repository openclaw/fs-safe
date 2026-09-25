use crate::{DirectoryObservation, NativeResult};

#[cfg(unix)]
use crate::DirectoryFdObservation;

#[cfg(unix)]
mod platform {
    use std::os::fd::AsRawFd;

    use napi::bindgen_prelude::BigInt;
    use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags, Stat};

    use super::{DirectoryFdObservation, DirectoryObservation};
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
    ) -> NativeResult<DirectoryFdObservation> {
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
        Ok(DirectoryFdObservation {
            dev: BigInt::from(after.st_dev as u64),
            ino: BigInt::from(after.st_ino as u64),
            mode: BigInt::from(u64::from(after.st_mode as u32)),
            nlink: BigInt::from(after.st_nlink as u64),
            real_path,
        })
    }

    pub(super) fn observe_directory_fd(
        fd: i32,
        expected_path: &str,
    ) -> NativeResult<DirectoryFdObservation> {
        observe_directory_fd_with(fd, expected_path, || inspect_named_directory(expected_path))
    }

    pub(super) fn observe_directory(path: &str) -> NativeResult<DirectoryObservation> {
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
        // Keep the temporary descriptor closed before allocating the N-API fields.
        drop(directory);
        Ok(DirectoryObservation {
            dev: BigInt::from(stat.st_dev as u64),
            ino: BigInt::from(stat.st_ino as u64),
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
    use std::os::windows::ffi::OsStrExt;

    use napi::bindgen_prelude::BigInt;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, GetFinalPathNameByHandleW,
    };

    use super::DirectoryObservation;
    use crate::{
        NativeResult, native_error,
        windows::{observe_directory_identity, open_existing_handle, win_error},
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

    const INITIAL_PATH_WCHARS: usize = 512;

    fn unavailable_path() -> napi::Error<String> {
        native_error("OBSERVATION_UNAVAILABLE", "observed directory path changed or could not be resolved")
    }

    fn canonical_path_with_query(
        handle: windows_sys::Win32::Foundation::HANDLE,
        mut query: impl FnMut(windows_sys::Win32::Foundation::HANDLE, &mut [u16]) -> NativeResult<usize>,
    ) -> NativeResult<String> {
        let mut stack = [0_u16; INITIAL_PATH_WCHARS];
        let written = query(handle, &mut stack)?;
        if written == 0 {
            return Err(unavailable_path());
        }
        let mut heap = Vec::new();
        let encoded = if written < stack.len() {
            &stack[..written]
        } else {
            // A too-small query reports the required capacity including NUL.
            // Retry once on the same handle, retaining the previous fail-closed
            // behavior if the normalized name grows beyond the new buffer.
            let capacity = written.checked_add(1)
                .filter(|capacity| *capacity <= u32::MAX as usize)
                .ok_or_else(unavailable_path)?;
            heap.try_reserve_exact(capacity).map_err(|_| unavailable_path())?;
            heap.resize(capacity, 0_u16);
            let confirmed = query(handle, &mut heap)?;
            if confirmed == 0 || confirmed >= heap.len() {
                return Err(unavailable_path());
            }
            &heap[..confirmed]
        };
        let path = String::from_utf16(encoded).map_err(|_| {
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

    fn canonical_path(handle: windows_sys::Win32::Foundation::HANDLE) -> NativeResult<String> {
        canonical_path_with_query(handle, |handle, buffer| {
            // Keep normalized names (flags 0): the opened spelling cannot prove
            // physical containment through a renamed or redirected ancestor.
            let written = unsafe {
                GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
            };
            if written == 0 {
                return Err(native_error(
                    "OBSERVATION_UNAVAILABLE",
                    format!(
                        "resolve observed directory path: Windows error {}",
                        unsafe { GetLastError() },
                    ),
                ));
            }
            Ok(written as usize)
        })
    }

    pub(super) fn observe_directory(path: &str) -> NativeResult<DirectoryObservation> {
        let path = wide_path(path)?;
        let handle = open_existing_handle(
            &path,
            FILE_READ_ATTRIBUTES,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            |code| win_error(code, "open directory observation"),
        )?;
        let (dev, ino) = observe_directory_identity(handle.0)?;
        let real_path = canonical_path(handle.0)?;
        // Keep the temporary handle closed before allocating the N-API fields.
        drop(handle);
        drop(path);
        Ok(DirectoryObservation {
            dev: BigInt::from(u64::from(dev)),
            ino: BigInt::from(ino),
            real_path,
        })
    }

    #[cfg(test)]
    mod tests {
        include!("directory_observation_windows_tests.rs");
    }
}

pub(crate) fn observe_directory(path: &str) -> NativeResult<DirectoryObservation> {
    platform::observe_directory(path)
}

#[cfg(unix)]
pub(crate) fn observe_directory_fd(
    fd: i32,
    expected_path: &str,
) -> NativeResult<DirectoryFdObservation> {
    platform::observe_directory_fd(fd, expected_path)
}
