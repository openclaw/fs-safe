use std::os::fd::IntoRawFd;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rustix::fs::{AtFlags, FileType, Mode, OFlags};

use crate::unix::{borrowed, os_error};
use crate::{NativeResult, into_napi, native_error};

fn validate_basename(name: &str) -> NativeResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(native_error(
            "EINVAL",
            "staging requires one direct-child basename",
        ));
    }
    Ok(())
}

fn create(parent_fd: i32, name: &str) -> NativeResult<i32> {
    validate_basename(name)?;
    // Direct children need no F_GETPATH post-open traversal check. Hand off the
    // fd immediately: the TS owner records cleanup authority before any fstat,
    // chmod, write, or pathname verification can fail.
    rustix::fs::openat(
        borrowed(parent_fd),
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_retain(0o600),
    )
    .map(IntoRawFd::into_raw_fd)
    .map_err(|error| os_error(error, "create staged child"))
}

fn matches(parent_fd: i32, name: &str, file_fd: i32) -> NativeResult<bool> {
    validate_basename(name)?;
    let created = rustix::fs::fstat(borrowed(file_fd))
        .map_err(|error| os_error(error, "inspect staged descriptor"))?;
    let current = rustix::fs::statat(borrowed(parent_fd), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect staged child"))?;
    Ok(FileType::from_raw_mode(created.st_mode).is_file()
        && FileType::from_raw_mode(current.st_mode).is_file()
        && created.st_dev == current.st_dev
        && created.st_ino == current.st_ino)
}

pub(crate) fn remove(parent_fd: i32, name: &str, file_fd: i32) -> NativeResult<&'static str> {
    match matches(parent_fd, name, file_fd) {
        Ok(false) => return Ok("preserved"),
        Err(error) if error.status == "ENOENT" => return Ok("name-absent"),
        Err(error) => return Err(error),
        Ok(true) => {}
    }
    // This is not atomic conditional unlink. Preserve observed substitutions;
    // a peer able to replace the leaf in this final gap still needs coordination.
    match rustix::fs::unlinkat(borrowed(parent_fd), name, AtFlags::empty()) {
        Ok(()) => Ok("removed"),
        Err(rustix::io::Errno::NOENT) => Ok("name-absent"),
        Err(error) => Err(os_error(error, "remove staged child")),
    }
}

#[napi(js_name = "createStagedFile")]
pub fn create_staged_file(env: Env, parent_fd: i32, basename: String) -> Result<i32> {
    into_napi(env, create(parent_fd, &basename))
}

#[napi(js_name = "stagedFileMatches")]
pub fn staged_file_matches(
    env: Env,
    parent_fd: i32,
    basename: String,
    file_fd: i32,
) -> Result<bool> {
    into_napi(env, matches(parent_fd, &basename, file_fd))
}

#[napi(js_name = "removeStagedFile")]
pub fn remove_staged_file(
    env: Env,
    parent_fd: i32,
    basename: String,
    file_fd: i32,
) -> Result<String> {
    into_napi(
        env,
        remove(parent_fd, &basename, file_fd).map(str::to_owned),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    #[test]
    fn retained_child_cleanup_is_exact_and_nonfollowing() {
        let base = std::env::temp_dir().join(format!("fs-safe-stage-{}", std::process::id()));
        std::fs::create_dir(&base).unwrap();
        let moved = base.with_extension("moved");
        let parent = std::fs::File::open(&base).unwrap();
        let fd = create(parent.as_raw_fd(), "stage").unwrap();
        // SAFETY: create returned a fresh descriptor owned by this test.
        let file = unsafe { OwnedFd::from_raw_fd(fd) };
        assert!(create(parent.as_raw_fd(), "stage").is_err());
        assert!(create(parent.as_raw_fd(), "../escape").is_err());
        rustix::fs::fchmod(&file, Mode::empty()).unwrap();
        assert!(matches(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap());
        std::fs::rename(&base, &moved).unwrap();
        std::fs::create_dir(&base).unwrap();
        std::fs::write(base.join("stage"), "replacement").unwrap();
        assert_eq!(
            remove(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap(),
            "removed"
        );
        assert_eq!(
            remove(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap(),
            "name-absent"
        );
        std::fs::write(moved.join("victim"), "victim").unwrap();
        std::os::unix::fs::symlink("victim", moved.join("stage")).unwrap();
        assert_eq!(
            remove(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap(),
            "preserved"
        );
        assert_eq!(
            std::fs::read_to_string(moved.join("victim")).unwrap(),
            "victim"
        );
        assert_eq!(
            std::fs::read_to_string(base.join("stage")).unwrap(),
            "replacement"
        );
        drop(file);
        drop(parent);
        std::fs::remove_dir_all(base).unwrap();
        std::fs::remove_dir_all(moved).unwrap();
    }
}
