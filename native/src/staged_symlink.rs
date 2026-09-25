use std::os::fd::IntoRawFd;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rustix::fs::{AtFlags, FileType, Mode, OFlags};

use crate::unix::{borrowed, nonnegative_fd, os_error, validate_child_basename};
use crate::{NativeResult, into_napi, native_error};

fn open(parent_fd: i32, name: &str) -> NativeResult<i32> {
    validate_child_basename(name)?;
    let parent_fd = nonnegative_fd(parent_fd, "retain staged symlink")?;
    // O_SYMLINK is not an only-symlinks filter. Refuse observed devices/FIFOs
    // before opening and bind the resulting handle to this observation.
    let before = rustix::fs::statat(borrowed(parent_fd), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect staged symlink before open"))?;
    if !FileType::from_raw_mode(before.st_mode).is_symlink() || before.st_nlink != 1 {
        return Err(native_error("EINVAL", "stage must be a singly linked symlink"));
    }
    #[cfg(target_os = "linux")]
    let flags = OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    #[cfg(target_os = "macos")]
    let flags = OFlags::from_bits_retain(libc::O_EVTONLY as u32)
        | OFlags::SYMLINK | OFlags::CLOEXEC | OFlags::NONBLOCK | OFlags::NOCTTY;
    let fd = rustix::fs::openat(borrowed(parent_fd), name, flags, Mode::empty())
        .map_err(|error| os_error(error, "retain staged symlink"))?;
    let stat = rustix::fs::fstat(&fd)
        .map_err(|error| os_error(error, "inspect retained symlink"))?;
    if !FileType::from_raw_mode(stat.st_mode).is_symlink() || stat.st_nlink != 1
        || stat.st_dev != before.st_dev || stat.st_ino != before.st_ino
    {
        return Err(native_error("EINVAL", "stage must be a singly linked symlink"));
    }
    Ok(fd.into_raw_fd())
}

fn matches(parent_fd: i32, name: &str, link_fd: i32) -> NativeResult<bool> {
    validate_child_basename(name)?;
    let parent_fd = nonnegative_fd(parent_fd, "inspect symlink parent")?;
    let link_fd = nonnegative_fd(link_fd, "inspect retained symlink")?;
    let held = rustix::fs::fstat(borrowed(link_fd))
        .map_err(|error| os_error(error, "inspect retained symlink"))?;
    let named = rustix::fs::statat(borrowed(parent_fd), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect staged symlink"))?;
    Ok(FileType::from_raw_mode(held.st_mode).is_symlink()
        && FileType::from_raw_mode(named.st_mode).is_symlink()
        && held.st_nlink == 1 && named.st_nlink == 1
        && held.st_dev == named.st_dev && held.st_ino == named.st_ino)
}

fn target(parent_fd: i32, name: &str, link_fd: i32) -> NativeResult<String> {
    if !matches(parent_fd, name, link_fd)? {
        return Err(native_error("EINVAL", "staged symlink identity changed"));
    }
    #[cfg(target_os = "linux")]
    let result = rustix::fs::readlinkat(borrowed(link_fd), "", Vec::new());
    #[cfg(target_os = "macos")]
    let result = rustix::fs::readlinkat(borrowed(parent_fd), name, Vec::new());
    let value = result.map_err(|error| os_error(error, "read retained symlink target"))?;
    let value = value.to_str()
        .map_err(|_| native_error("EINVAL", "symlink target is not UTF-8"))?.to_owned();
    if !matches(parent_fd, name, link_fd)? {
        return Err(native_error("EINVAL", "staged symlink identity changed"));
    }
    Ok(value)
}

#[napi(js_name = "openStagedSymlink")]
pub fn open_staged_symlink(env: Env, parent_fd: i32, name: String) -> Result<i32> {
    into_napi(env, open(parent_fd, &name))
}

#[napi(js_name = "stagedSymlinkTarget")]
pub fn staged_symlink_target(env: Env, parent_fd: i32, name: String, link_fd: i32) -> Result<String> {
    into_napi(env, target(parent_fd, &name, link_fd))
}

#[napi(js_name = "stagedSymlinkMatches")]
pub fn staged_symlink_matches(env: Env, parent_fd: i32, name: String, link_fd: i32) -> Result<bool> {
    into_napi(env, matches(parent_fd, &name, link_fd))
}

#[napi(js_name = "publishStagedSymlink")]
pub fn publish_staged_symlink(
    env: Env, parent_fd: i32, name: String, link_fd: i32, destination: String,
) -> Result<()> {
    let result = (|| {
        validate_child_basename(&destination)?;
        // Explicit pre-dispatch provenance; ordinary rename errors remain ambiguous.
        if name == destination || !matches(parent_fd, &name, link_fd)? {
            return Err(native_error(
                "FS_SAFE_INTERNAL_RENAME_SOURCE_IDENTITY_MISMATCH",
                "staged symlink no longer names the retained inode",
            ));
        }
        crate::unix::rename_no_replace(parent_fd, &name, parent_fd, &destination)
    })();
    into_napi(env, result)
}

#[napi(js_name = "removeStagedSymlink")]
pub fn remove_staged_symlink(env: Env, parent_fd: i32, name: String, link_fd: i32) -> Result<String> {
    let result = (|| {
        match matches(parent_fd, &name, link_fd) {
            Ok(false) => return Ok("preserved"),
            Err(error) if error.status == "ENOENT" => return Ok("name-absent"),
            Err(error) => return Err(error),
            Ok(true) => {}
        }
        // Directory-relative, not conditional unlink: callers must coordinate writers.
        match rustix::fs::unlinkat(borrowed(parent_fd), name.as_str(), AtFlags::empty()) {
            Ok(()) => Ok("removed"),
            Err(rustix::io::Errno::NOENT) => Ok("name-absent"),
            Err(error) => Err(os_error(error, "remove retained symlink")),
        }
    })();
    into_napi(env, result.map(str::to_owned))
}

#[cfg(test)]
#[path = "staged_symlink_tests.rs"]
mod tests;
