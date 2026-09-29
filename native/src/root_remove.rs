use std::os::fd::{AsRawFd, OwnedFd};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rustix::fs::{AtFlags, Dir, FileType, Stat};

use crate::{ExactFileIdentity, NativeResult, into_napi, native_error, validate_child_basename};
use crate::unix::{borrowed, nonnegative_fd, open_cleanup_directory, os_error};

fn inspect(parent: i32, name: &str) -> NativeResult<Stat> {
    nonnegative_fd(parent, "inspect removal parent")?;
    validate_child_basename(name)?;
    rustix::fs::statat(borrowed(parent), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect removal entry"))
}

// Darwin's device type differs from Linux's; keep the same unsigned identity projection.
#[allow(clippy::unnecessary_cast)]
fn verify(stat: &Stat, expected: ExactFileIdentity) -> NativeResult<()> {
    if stat.st_dev as u64 != expected.dev || stat.st_ino as u64 != expected.ino {
        return Err(native_error("path-mismatch", "removal entry identity changed"));
    }
    Ok(())
}

fn unlink_entry(
    parent: i32, name: &str, expected: ExactFileIdentity, directory: bool,
) -> NativeResult<()> {
    nonnegative_fd(parent, "remove child")?;
    validate_child_basename(name)?;
    let stat = inspect(parent, name)?;
    verify(&stat, expected)?;
    if FileType::from_raw_mode(stat.st_mode).is_dir() != directory {
        return Err(native_error("path-mismatch", "removal entry type changed"));
    }
    // POSIX has no conditional unlink. A final replacement can be unlinked,
    // but a link is never followed and the retained parent is never reopened.
    rustix::fs::unlinkat(borrowed(parent), name,
        if directory { AtFlags::REMOVEDIR } else { AtFlags::empty() })
        .map_err(|error| os_error(error, "remove child relative to retained parent"))
}

#[napi(object)]
pub struct RootRemovalEntry {
    pub dev: BigInt,
    pub ino: BigInt,
    pub directory: bool,
    pub symlink: bool,
}

#[napi(js_name = "rootRemovalStat")]
#[allow(clippy::unnecessary_cast)] // Platform-dependent stat device/inode widths.
pub fn root_removal_stat(env: Env, parent: i32, name: String) -> Result<RootRemovalEntry> {
    into_napi(env, inspect(parent, &name).map(|stat| RootRemovalEntry {
        dev: BigInt::from(stat.st_dev as u64), ino: BigInt::from(stat.st_ino as u64),
        directory: FileType::from_raw_mode(stat.st_mode).is_dir(),
        symlink: FileType::from_raw_mode(stat.st_mode).is_symlink(),
    }))
}

#[napi(js_name = "rootRemovalUnlink")]
pub fn root_removal_unlink(
    env: Env, parent: i32, name: String, dev: BigInt, ino: BigInt, directory: bool,
) -> Result<()> {
    into_napi(env, crate::exact_file_identity(&dev, &ino).and_then(|identity| {
        unlink_entry(parent, &name, identity, directory)
    }))
}

#[napi]
pub struct RootRemovalDirectory {
    descriptor: Option<OwnedFd>,
    stream: Option<Dir>,
}

fn open_directory(
    parent: i32, name: &str, expected: ExactFileIdentity,
) -> NativeResult<RootRemovalDirectory> {
    nonnegative_fd(parent, "open removal directory")?;
    validate_child_basename(name)?;
    let name = std::ffi::CString::new(name)
        .map_err(|_| native_error("EINVAL", "removal name contains NUL"))?;
    let descriptor = open_cleanup_directory(parent, &name)?;
    let stat = rustix::fs::fstat(&descriptor)
        .map_err(|error| os_error(error, "inspect removal directory"))?;
    verify(&stat, expected)?;
    let stream = Dir::read_from(&descriptor)
        .map_err(|error| os_error(error, "open removal directory stream"))?;
    Ok(RootRemovalDirectory { descriptor: Some(descriptor), stream: Some(stream) })
}

#[napi(js_name = "openRootRemovalDirectory")]
pub fn open_root_removal_directory(
    env: Env, parent: i32, name: String, dev: BigInt, ino: BigInt,
) -> Result<RootRemovalDirectory> {
    into_napi(env, crate::exact_file_identity(&dev, &ino).and_then(|expected| {
        open_directory(parent, &name, expected)
    }))
}

#[napi]
impl RootRemovalDirectory {
    #[napi(getter)]
    pub fn fd(&self, env: Env) -> Result<i32> {
        into_napi(env, self.descriptor.as_ref().map(AsRawFd::as_raw_fd)
            .ok_or_else(|| native_error("EBADF", "removal directory is closed")))
    }

    #[napi]
    pub fn read(&mut self, env: Env) -> Result<Option<String>> {
        into_napi(env, self.read_name())
    }

    #[napi]
    pub fn close(&mut self) {
        self.stream.take();
        self.descriptor.take();
    }
}

impl RootRemovalDirectory {
    fn read_name(&mut self) -> NativeResult<Option<String>> {
        let stream = self.stream.as_mut()
            .ok_or_else(|| native_error("EBADF", "removal directory is closed"))?;
        for entry in stream {
            let entry = entry.map_err(|error| os_error(error, "read removal directory"))?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") { continue; }
            // Refuse names that Node cannot represent exactly; never unlink a
            // lossy UTF-8 replacement spelling.
            return name.to_str().map(|name| Some(name.to_owned()))
                .map_err(|_| native_error("EINVAL", "removal entry is not UTF-8"));
        }
        Ok(None)
    }
}

#[cfg(test)]
#[path = "root_remove_tests.rs"]
mod tests;
