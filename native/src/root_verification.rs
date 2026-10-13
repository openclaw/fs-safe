use napi::{Env, Result};
use napi::bindgen_prelude::BigInt;
use napi_derive::napi;

use crate::{NativeResult, exact_file_identity, into_napi};

#[cfg(unix)]
mod platform {
    use std::os::fd::{AsRawFd, IntoRawFd, OwnedFd};
    use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags};
    use crate::{ExactFileIdentity, NativeResult, native_error};

    pub(super) struct Owner {
        directory: Option<OwnedFd>,
        path: String,
        expected: ExactFileIdentity,
    }

    impl Owner {
        pub(super) fn open(path: String, expected: ExactFileIdentity) -> NativeResult<Self> {
            if !path.starts_with('/') || path.as_bytes().contains(&0) {
                return Err(native_error("EINVAL", "root verification requires an absolute path"));
            }
            #[cfg(target_os = "linux")]
            let access = OFlags::PATH;
            #[cfg(target_os = "macos")]
            let access = OFlags::from_bits_retain(0x40000000); // Darwin O_SEARCH.
            let directory = rustix::fs::openat(CWD, &path, access | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())
                .map_err(|error| crate::unix::os_error(error, "open root verification"))?;
            Ok(Self { directory: Some(directory), path, expected })
        }

        #[allow(clippy::unnecessary_cast)] // Stat widths differ across POSIX targets.
        pub(super) fn assert_current(&self) -> NativeResult<()> {
            self.assert_with_final(|| Ok(()))
        }

        #[allow(clippy::unnecessary_cast)] // Stat widths differ across POSIX targets.
        pub(super) fn assert_with_final(&self, before_final: impl FnOnce() -> NativeResult<()>) -> NativeResult<()> {
            let directory = self.directory.as_ref().ok_or_else(|| native_error("EBADF", "root verification is closed"))?;
            let before = rustix::fs::fstat(directory)
                .map_err(|error| crate::unix::os_error(error, "inspect root verification"))?;
            if !FileType::from_raw_mode(before.st_mode).is_dir() || before.st_nlink == 0
                || before.st_dev as u64 != self.expected.dev || before.st_ino as u64 != self.expected.ino {
                return Err(native_error("path-mismatch", "root descriptor identity changed"));
            }
            let mut before_final = Some(before_final);
            for index in 0..2 {
                if crate::directory_observation::canonical_unix_directory(directory.as_raw_fd(), before.st_nlink as u64)? != self.path {
                    return Err(native_error("path-mismatch", "root canonical path changed"));
                }
                if index == 1 { before_final.take().unwrap()()?; }
                let named = rustix::fs::statat(CWD, self.path.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(|error| native_error("path-mismatch", format!("root name could not be verified: {error}")))?;
                // The final named sample identifies this still-pinned inode,
                // so its fresh metadata also verifies the retained object.
                if named.st_dev != before.st_dev || named.st_ino != before.st_ino
                    || named.st_mode != before.st_mode || named.st_nlink != before.st_nlink {
                    return Err(native_error("path-mismatch", "root name or metadata changed"));
                }
            }
            Ok(())
        }

        pub(super) fn close(&mut self) -> NativeResult<()> {
            if let Some(directory) = self.directory.take() {
                crate::unix::close_owned_fd(directory.into_raw_fd())?;
            }
            Ok(())
        }

        pub(super) fn fallback_fd(&mut self) -> NativeResult<i32> {
            self.directory.take().map(IntoRawFd::into_raw_fd)
                .ok_or_else(|| native_error("EBADF", "root verification is closed"))
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_READ_ATTRIBUTES,
    };
    use crate::{ExactFileIdentity, NativeResult, native_error};
    use crate::windows::{OwnedHandle, guarded_handle_information, open_existing_handle, wide_absolute_path, win_error};

    pub(super) struct Owner {
        directory: Option<OwnedHandle>,
        path: String,
        expected: ExactFileIdentity,
    }

    fn facts(handle: HANDLE, expected: ExactFileIdentity) -> NativeResult<(u64, u64, u32, u32)> {
        for attempt in 0..2 {
            let info = guarded_handle_information(handle, "inspect root directory verification")?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(native_error("path-mismatch", "root directory type changed"));
            }
            let dev = u64::from(info.dwVolumeSerialNumber);
            let ino = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
            if (dev != 0 && dev != expected.dev) || (ino != 0 && ino != expected.ino) {
                return Err(native_error("path-mismatch", "root directory identity changed"));
            }
            if dev != 0 && ino != 0 {
                return Ok((dev, ino, info.dwFileAttributes & FILE_ATTRIBUTE_READONLY, info.nNumberOfLinks));
            }
            if attempt == 1 { return Err(native_error("path-mismatch", "root directory identity is unknown")); }
        }
        unreachable!()
    }

    impl Owner {
        pub(super) fn open(path: String, expected: ExactFileIdentity) -> NativeResult<Self> {
            crate::validate_windows_filesystem_path(&path)?;
            if !std::path::Path::new(&path).is_absolute() || path.contains('\0') {
                return Err(native_error("EINVAL", "root verification requires an absolute path"));
            }
            let directory = open_existing_handle(&wide_absolute_path(&path), FILE_GENERIC_READ,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                |code| win_error(code, "open root verification"))?;
            Ok(Self { directory: Some(directory), path, expected })
        }

        pub(super) fn assert_current(&self) -> NativeResult<()> {
            self.assert_with_final(|| Ok(()))
        }

        pub(super) fn assert_with_final(&self, before_final: impl FnOnce() -> NativeResult<()>) -> NativeResult<()> {
            let directory = self.directory.as_ref().ok_or_else(|| native_error("EBADF", "root verification is closed"))?;
            let before = facts(directory.0, self.expected)?;
            let spelling = wide_absolute_path(&self.path);
            let open_named = || open_existing_handle(&spelling, FILE_READ_ATTRIBUTES,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                |code| win_error(code, "open named root verification"));
            for _ in 0..2 {
                let named = open_named()?;
                if facts(named.0, self.expected)? != before
                    || crate::directory_observation::canonical_windows_directory(named.0, &self.path)? != self.path {
                    return Err(native_error("path-mismatch", "named root changed during verification"));
                }
            }
            before_final()?;
            let final_named = open_named()
                .map_err(|error| native_error("path-mismatch", format!("final root name could not be verified: {}", error.reason)))?;
            if facts(final_named.0, self.expected)? != before {
                return Err(native_error("path-mismatch", "root metadata changed after canonicalization"));
            }
            Ok(())
        }

        pub(super) fn close(&mut self) -> NativeResult<()> {
            if let Some(directory) = self.directory.take() { directory.close()?; }
            Ok(())
        }

        pub(super) fn fallback_fd(&mut self) -> NativeResult<i32> {
            crate::windows::transfer_owned_handle_to_runtime(&mut self.directory)
        }
    }
}

#[napi(object)]
pub struct RootVerificationFailure {
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_errno: Option<u32>,
    pub close_error_code: Option<String>,
    pub close_error_message: Option<String>,
    pub close_error_errno: Option<u32>,
    pub fallback_fd: Option<i32>,
}

fn verify(path: String, expected: crate::ExactFileIdentity) -> NativeResult<Option<RootVerificationFailure>> {
    let owner = platform::Owner::open(path, expected)?;
    verify_owner(owner, |owner| owner.assert_current(), |owner| owner.close())
}

fn verify_owner(
    mut owner: platform::Owner,
    assert: impl FnOnce(&platform::Owner) -> NativeResult<()>,
    close: impl FnOnce(&mut platform::Owner) -> NativeResult<()>,
) -> NativeResult<Option<RootVerificationFailure>> {
    let mut error = assert(&owner).err();
    if error.as_ref().is_some_and(|error| error.status == "OBSERVATION_UNAVAILABLE") {
        match owner.fallback_fd() {
            Ok(fd) => return Ok(Some(RootVerificationFailure {
                error_code: None, error_message: None, error_errno: None,
                close_error_code: None, close_error_message: None, close_error_errno: None, fallback_fd: Some(fd),
            })),
            Err(transfer) => error = Some(transfer),
        }
    }
    let close_error = close(&mut owner).err();
    if error.is_none() && close_error.is_none() { return Ok(None); }
    Ok(Some(RootVerificationFailure {
        error_code: error.as_ref().map(|error| error.status.clone()),
        error_errno: error.as_ref().and_then(|error| error.errno),
        error_message: error.map(|error| error.reason),
        close_error_code: close_error.as_ref().map(|error| error.status.clone()),
        close_error_errno: close_error.as_ref().and_then(|error| error.errno),
        close_error_message: close_error.map(|error| error.reason),
        fallback_fd: None,
    }))
}

#[napi(js_name = "verifyRootDirectory")]
pub fn verify_root_directory(env: Env, path: String, dev: BigInt, ino: BigInt) -> Result<Option<RootVerificationFailure>> {
    into_napi(env, exact_file_identity(&dev, &ino).and_then(|expected| verify(path, expected)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, fs, path::PathBuf};
    use crate::ExactFileIdentity;

    struct Fixture { base: PathBuf, root: PathBuf, expected: ExactFileIdentity }
    impl Fixture {
        fn new() -> Self {
            let base = crate::test_support::temp_path("root-verification");
            fs::create_dir_all(base.join("root")).unwrap();
            let root = PathBuf::from(crate::directory_observation::observe_directory(base.join("root").to_str().unwrap()).unwrap().real_path);
            #[cfg(unix)]
            let expected = {
                use std::os::unix::fs::MetadataExt;
                let stat = fs::metadata(&root).unwrap();
                ExactFileIdentity { dev: stat.dev(), ino: stat.ino() }
            };
            #[cfg(windows)]
            let expected = {
                use std::os::windows::io::AsRawHandle;
                let file = crate::test_support::directory(&root);
                let (dev, ino, _) = crate::windows::handle_identity(file.as_raw_handle()).unwrap();
                ExactFileIdentity { dev: u64::from(dev), ino }
            };
            Self { base, root, expected }
        }
        fn owner(&self) -> platform::Owner { platform::Owner::open(self.root.to_str().unwrap().into(), self.expected).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.base).unwrap(); } }

    #[test]
    fn final_named_fence_rejects_replacement_after_canonical_observation() {
        let fixture = Fixture::new();
        let mut owner = fixture.owner();
        let error = owner.assert_with_final(|| {
            fs::rename(&fixture.root, fixture.base.join("held")).unwrap();
            fs::create_dir(&fixture.root).unwrap();
            Ok(())
        }).unwrap_err();
        assert_eq!(error.status, "path-mismatch");
        owner.close().unwrap();
        assert!(fixture.base.join("held").is_dir());
        assert!(fixture.root.is_dir());
    }

    #[test]
    fn reports_both_failures_and_consumes_close_once() {
        let fixture = Fixture::new();
        let closes = Cell::new(0);
        let result = verify_owner(fixture.owner(), |_| Err(crate::native_error("path-mismatch", "verify failed")), |owner| {
            closes.set(closes.get() + 1);
            owner.close()?;
            Err(crate::native_error("EIO", "close failed"))
        }).unwrap().unwrap();
        assert_eq!(result.error_code.as_deref(), Some("path-mismatch"));
        assert_eq!(result.close_error_code.as_deref(), Some("EIO"));
        assert_eq!(result.fallback_fd, None);
        assert_eq!(closes.get(), 1);
    }

    #[test]
    fn final_named_fence_retains_metadata_comparison() {
        let fixture = Fixture::new();
        let mut owner = fixture.owner();
        let original = fs::metadata(&fixture.root).unwrap().permissions();
        let outcome = owner.assert_with_final(|| {
            let mut changed = original.clone();
            changed.set_readonly(true);
            fs::set_permissions(&fixture.root, changed).unwrap();
            Ok(())
        });
        owner.close().unwrap();
        fs::set_permissions(&fixture.root, original).unwrap();
        let error = outcome.unwrap_err();
        assert_eq!(error.status, "path-mismatch");
    }

    #[cfg(unix)]
    #[test]
    fn unavailable_observation_transfers_the_original_live_descriptor() {
        use std::os::{fd::FromRawFd, unix::fs::MetadataExt};
        let fixture = Fixture::new();
        let closes = Cell::new(0);
        let result = verify_owner(fixture.owner(), |_| Err(crate::native_error("OBSERVATION_UNAVAILABLE", "unsupported")), |owner| {
            closes.set(closes.get() + 1);
            owner.close()
        }).unwrap().unwrap();
        assert_eq!(closes.get(), 0);
        // SAFETY: the failure receipt transfers this one owned descriptor.
        let held = unsafe { fs::File::from_raw_fd(result.fallback_fd.unwrap()) };
        assert_eq!(held.metadata().unwrap().ino(), fixture.expected.ino);
        assert!(held.metadata().unwrap().is_dir());
    }

    #[test]
    fn rejects_unknown_expected_identity_and_closes_normally() {
        let fixture = Fixture::new();
        let result = verify(fixture.root.to_str().unwrap().into(), ExactFileIdentity { dev: fixture.expected.dev, ino: fixture.expected.ino ^ (1_u64 << 63) }).unwrap().unwrap();
        assert_eq!(result.error_code.as_deref(), Some("path-mismatch"));
        assert_eq!(result.close_error_code, None);
        assert_eq!(result.fallback_fd, None);
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn retained_root_open_preserves_the_openat_syscall_contract() {
        const TEST: &str = "root_verification::tests::retained_root_open_preserves_the_openat_syscall_contract";
        if std::env::var_os("FS_SAFE_ROOT_OPENAT_CHILD").is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"]).env("FS_SAFE_ROOT_OPENAT_CHILD", "1")
                .output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            return;
        }
        let fixture = Fixture::new();
        let instructions = [
            libc::sock_filter { code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
                jt: 0, jf: 0, k: std::mem::offset_of!(libc::seccomp_data, nr) as u32 },
            libc::sock_filter { code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
                jt: 0, jf: 1, k: libc::SYS_open as u32 },
            libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16,
                jt: 0, jf: 0, k: libc::SECCOMP_RET_ERRNO | libc::EACCES as u32 },
            libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16,
                jt: 0, jf: 0, k: libc::SECCOMP_RET_ALLOW },
        ];
        let program = libc::sock_fprog { len: instructions.len() as u16, filter: instructions.as_ptr().cast_mut() };
        // The filter is confined to this dedicated child test process.
        unsafe {
            assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);
            assert_eq!(libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program), 0);
        }
        assert!(verify(fixture.root.to_str().unwrap().into(), fixture.expected).unwrap().is_none());
    }
}
