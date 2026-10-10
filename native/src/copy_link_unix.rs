use napi::{Env, Result, bindgen_prelude::{BigInt, Buffer}};
use napi_derive::napi;
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use crate::unix::{borrowed, os_error};
use crate::{into_napi, native_error, validate_child_basename};

pub(crate) fn create(parent: i32, name: &str, target: &std::ffi::CStr) -> crate::NativeResult<()> {
    rustix::fs::symlinkat(target, borrowed(parent), name)
        .map_err(|error| os_error(error, "create copied symbolic link"))
}

use crate::copy_timestamps_unix::{timespec, link as restore_timestamps};

#[napi(js_name = "createCopySymlink")]
pub fn create_copy_symlink(env: Env, parent: i32, name: String, target: Buffer, mode: u32,
    atime_ns: Option<BigInt>, mtime_ns: Option<BigInt>,
) -> Result<CopySymlinkResult> {
    into_napi(env, create_with_metadata(parent, &name, &target, mode, atime_ns, mtime_ns))
}

fn create_with_metadata(parent: i32, name: &str, target: &[u8], mode: u32,
    atime_ns: Option<BigInt>, mtime_ns: Option<BigInt>,
) -> crate::NativeResult<CopySymlinkResult> {
    validate_child_basename(name)?;
    crate::unix::nonnegative_fd(parent, "create copied link")?;
    let target = CString::new(target).map_err(|_| native_error("EINVAL", "link target contains NUL"))?;
    let times = match (atime_ns, mtime_ns) {
        (Some(a), Some(m)) => Some(rustix::fs::Timestamps { last_access: timespec(a)?, last_modification: timespec(m)? }),
        (None, None) => None,
        _ => return Err(native_error("EINVAL", "both link timestamps are required")),
    };
    create(parent, name, &target)?;
    let created = rustix::fs::statat(borrowed(parent), name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect created symbolic link"))?;
    if !rustix::fs::FileType::from_raw_mode(created.st_mode).is_symlink() || created.st_nlink != 1 {
        return Err(native_error("path-mismatch", "created symbolic link changed"));
    }
    // Capture cleanup identity before acquiring another descriptor: that open
    // can fail with EMFILE even after symlinkat has successfully created a name.
    let error = (|| {
        let link = unsafe { OwnedFd::from_raw_fd(crate::staged_symlink::open(parent, name)?) };
        let held = rustix::fs::fstat(&link)
            .map_err(|error| os_error(error, "inspect retained symbolic link"))?;
        if held.st_dev != created.st_dev || held.st_ino != created.st_ino {
            return Err(native_error("path-mismatch", "created symbolic link changed before retention"));
        }
        #[cfg(target_os = "macos")]
        rustix::fs::fchmod(&link, rustix::fs::Mode::from_bits_retain(mode as _))
            .map_err(|error| os_error(error, "set copied link permissions"))?;
        #[cfg(target_os = "linux")]
        let _ = mode;
        if let Some(times) = times { restore_timestamps(link.as_raw_fd(), &times)?; }
        Ok::<(), crate::NativeError>(())
    })().err();
    Ok(CopySymlinkResult {
        dev: BigInt::from(i128::from(created.st_dev)), ino: BigInt::from(u128::from(created.st_ino)),
        error_code: error.as_ref().map(|e| e.status.clone()),
        error_message: error.map(|e| e.reason),
    })
}

#[napi(object)]
pub struct CopySymlinkResult {
    pub dev: BigInt,
    pub ino: BigInt,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn descriptor_exhaustion_returns_created_link_identity() {
        crate::test_support::isolated_admission_test(
            "copy_link_unix::tests::descriptor_exhaustion_returns_created_link_identity", || {
                let directory = crate::test_support::temp_path("link-emfile");
                fs::create_dir(&directory).unwrap();
                let parent = fs::File::open(&directory).unwrap();
                let mut saved = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
                assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut saved) }, 0);
                let limit = libc::rlimit { rlim_cur: 0, rlim_max: saved.rlim_max };
                assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
                let result = create_with_metadata(parent.as_raw_fd(), "stage", b"missing", 0o600, None, None);
                assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &saved) }, 0);
                let result = result.unwrap();
                assert_eq!(result.error_code.as_deref(), Some("EMFILE"));
                let held = rustix::fs::statat(borrowed(parent.as_raw_fd()), "stage", rustix::fs::AtFlags::SYMLINK_NOFOLLOW).unwrap();
                assert_eq!(result.ino.get_u64().1, held.st_ino);
                fs::remove_dir_all(directory).unwrap();
            },
        );
    }

    #[test]
    fn timestamp_restore_cannot_touch_a_replacement_hardlink() {
        let directory = crate::test_support::temp_path("link-timestamps");
        fs::create_dir(&directory).unwrap();
        let outside = directory.join("outside");
        fs::write(&outside, b"untouched").unwrap();
        let original = fs::metadata(&outside).unwrap().modified().unwrap();
        symlink("missing", directory.join("stage")).unwrap();
        let parent = fs::File::open(&directory).unwrap();
        let link = unsafe { OwnedFd::from_raw_fd(crate::staged_symlink::open(parent.as_raw_fd(), "stage").unwrap()) };
        fs::remove_file(directory.join("stage")).unwrap();
        fs::hard_link(&outside, directory.join("stage")).unwrap();
        let times = rustix::fs::Timestamps {
            last_access: rustix::fs::Timespec { tv_sec: 123, tv_nsec: 0 },
            last_modification: rustix::fs::Timespec { tv_sec: 456, tv_nsec: 0 },
        };
        restore_timestamps(link.as_raw_fd(), &times).unwrap();
        assert_eq!(fs::metadata(&outside).unwrap().modified().unwrap(), original);
        assert!(crate::staged_symlink::open(parent.as_raw_fd(), "stage").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
