use std::os::fd::IntoRawFd;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rustix::fs::{AtFlags, FileType, Mode, OFlags};

use crate::unix::{
    borrowed, file_matches_child as matches, nonnegative_fd, os_error,
    remove_matching_child as remove, validate_child_basename,
};
use crate::{NativeResult, into_napi};
use crate::task::NativeTask;

fn create(parent_fd: i32, name: &str) -> NativeResult<i32> {
    validate_child_basename(name)?;
    let parent_fd = nonnegative_fd(parent_fd, "create staged child")?;
    // Direct children need no F_GETPATH post-open traversal check. Hand off the
    // fd immediately: the TS owner records cleanup authority before any fstat,
    // chmod, write, or pathname verification can fail.
    rustix::fs::openat(
        borrowed(parent_fd),
        name,
        // Retain read authority for replaying completed one-shot input if
        // no-replace publication is unsupported; never reopen the stage name.
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_retain(0o600),
    )
    .map(IntoRawFd::into_raw_fd)
    .map_err(|error| os_error(error, "create staged child"))
}

#[napi(js_name = "createStagedFile")]
pub fn create_staged_file(parent_fd: i32, basename: String) -> AsyncTask<NativeTask<i32>> {
    // No early cancellation: the caller owns parent_fd until settlement and must
    // receive the created descriptor before any fallible inspection or cleanup.
    AsyncTask::new(NativeTask::new(move || create(parent_fd, &basename)))
}

fn rename_async(source_fd: i32, source: String, target_fd: i32, target: String, overwrite: bool) -> AsyncTask<NativeTask<()>> {
    // Borrow the admitted parents for the entire task, just like native copying.
    // Reuse the synchronous primitives so syscall flags and error provenance agree.
    AsyncTask::new(NativeTask::new(move || {
        crate::validate_relative_path(&source, false)?;
        crate::validate_relative_path(&target, false)?;
        if overwrite {
            crate::unix::rename_replace(source_fd, &source, target_fd, &target)
        } else {
            crate::unix::rename_no_replace(source_fd, &source, target_fd, &target)
        }
    }))
}

#[napi(js_name = "renameReplaceAsync")]
pub fn rename_replace_async(source_fd: i32, source: String, target_fd: i32, target: String) -> AsyncTask<NativeTask<()>> {
    rename_async(source_fd, source, target_fd, target, true)
}

#[napi(js_name = "renameNoReplaceAsync")]
pub fn rename_no_replace_async(source_fd: i32, source: String, target_fd: i32, target: String) -> AsyncTask<NativeTask<()>> {
    rename_async(source_fd, source, target_fd, target, false)
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

#[napi(object)]
pub struct StagedFileMetadata {
    pub mode: BigInt,
    pub nlink: BigInt,
}

#[allow(clippy::unnecessary_cast)] // Stat widths differ across POSIX targets.
fn inspect_staged_file(parent_fd: i32, name: &str, file_fd: i32) -> NativeResult<Option<StagedFileMetadata>> {
    validate_child_basename(name)?;
    let file_fd = nonnegative_fd(file_fd, "inspect staged descriptor")?;
    let parent_fd = nonnegative_fd(parent_fd, "inspect staged child")?;
    let named = rustix::fs::statat(borrowed(parent_fd), name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(|error| os_error(error, "inspect staged child"))?;
    // The synchronous caller owns this descriptor throughout the observation.
    // Sample it after the name, replacing the former post-match JS fstat.
    let retained = rustix::fs::fstat(borrowed(file_fd))
        .map_err(|error| os_error(error, "inspect staged descriptor"))?;
    if !FileType::from_raw_mode(named.st_mode).is_file()
        || !FileType::from_raw_mode(retained.st_mode).is_file()
        || named.st_dev != retained.st_dev || named.st_ino != retained.st_ino {
        return Ok(None);
    }
    Ok(Some(StagedFileMetadata {
        mode: BigInt::from(retained.st_mode as u64),
        nlink: BigInt::from(retained.st_nlink as u64),
    }))
}

#[napi(js_name = "stagedFileMetadata")]
pub fn staged_file_metadata(env: Env, parent_fd: i32, basename: String, file_fd: i32) -> Result<Option<StagedFileMetadata>> {
    into_napi(env, inspect_staged_file(parent_fd, &basename, file_fd))
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
    fn staged_metadata_observes_the_named_inode_without_closing_it() {
        let base = std::env::temp_dir().join(format!("fs-safe-stage-metadata-{}", std::process::id()));
        std::fs::create_dir(&base).unwrap();
        let parent = std::fs::File::open(&base).unwrap();
        let fd = create(parent.as_raw_fd(), "stage").unwrap();
        // SAFETY: create returned a descriptor uniquely owned by this test.
        let file = unsafe { OwnedFd::from_raw_fd(fd) };
        let observed = inspect_staged_file(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap().unwrap();
        assert_eq!(observed.nlink.get_u64().1, 1);
        std::fs::hard_link(base.join("stage"), base.join("alias")).unwrap();
        assert_eq!(inspect_staged_file(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap().unwrap().nlink.get_u64().1, 2);
        std::fs::rename(base.join("stage"), base.join("held")).unwrap();
        std::fs::write(base.join("stage"), b"replacement").unwrap();
        assert!(inspect_staged_file(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap().is_none());
        std::fs::remove_file(base.join("stage")).unwrap();
        std::os::unix::fs::symlink("held", base.join("stage")).unwrap();
        assert!(inspect_staged_file(parent.as_raw_fd(), "stage", file.as_raw_fd()).unwrap().is_none());
        assert!(inspect_staged_file(parent.as_raw_fd(), "../escape", file.as_raw_fd()).is_err());
        assert!(rustix::fs::fstat(&file).is_ok());
        drop(file);
        drop(parent);
        std::fs::remove_dir_all(base).unwrap();
    }

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
