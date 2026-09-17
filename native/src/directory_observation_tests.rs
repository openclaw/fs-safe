use std::fs::{self, File};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fs-safe-directory-observation-{label}-{}-{nonce}", std::process::id(),
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn directory(&self, name: &str) -> (PathBuf, File) {
        let path = self.0.join(name);
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let directory = File::open(&path).unwrap();
        (path, directory)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn retained_directory_observation_preserves_exact_metadata_and_fd_ownership() {
    let fixture = Fixture::new("exact");
    let (path, directory) = fixture.directory("directory");
    fs::create_dir(path.join("child")).unwrap();
    let expected = rustix::fs::fstat(directory.as_fd()).unwrap();
    for _ in 0..3 {
        let observed = observe_directory_fd(directory.as_raw_fd(), path.to_str().unwrap()).unwrap();
        assert_eq!(observed.dev, expected.st_dev as u64);
        assert_eq!(observed.ino, expected.st_ino as u64);
        assert_eq!(observed.mode, expected.st_mode as u32);
        assert_eq!(observed.nlink, expected.st_nlink as u64);
        assert_eq!(observed.real_path, path.to_str().unwrap());
        assert!(same_directory(&expected, &rustix::fs::fstat(directory.as_fd()).unwrap()));
    }
}

#[test]
fn retained_directory_observation_rejects_invalid_fd_and_non_directory_without_closing() {
    let fixture = Fixture::new("invalid");
    assert_eq!(observe_directory_fd(-1, fixture.0.to_str().unwrap()).unwrap_err().status, "EBADF");
    let path = fixture.0.join("file");
    let file = File::create(&path).unwrap();
    assert_eq!(observe_directory_fd(file.as_raw_fd(), path.to_str().unwrap()).unwrap_err().status, "ENOTDIR");
    file.metadata().unwrap();
}

#[test]
fn retained_directory_observation_requires_exact_canonical_spelling() {
    let fixture = Fixture::new("spelling");
    let (path, directory) = fixture.directory("directory");
    let canonical = path.to_str().unwrap();
    for spelling in [format!("{canonical}/"), format!("{canonical}/."), format!("{canonical}/../directory")] {
        assert_eq!(observe_directory_fd(directory.as_raw_fd(), &spelling).unwrap_err().status, "OBSERVATION_REDIRECTED");
    }
    for invalid in ["directory", "/directory\0suffix"] {
        assert_eq!(observe_directory_fd(directory.as_raw_fd(), invalid).unwrap_err().status, "EINVAL");
    }
    let alias = fixture.0.join("alias");
    symlink(&path, &alias).unwrap();
    assert_eq!(observe_directory_fd(directory.as_raw_fd(), alias.to_str().unwrap()).unwrap_err().status, "OBSERVATION_REDIRECTED");
    directory.metadata().unwrap();
}

#[test]
fn moved_or_replaced_directory_cannot_reuse_the_original_name() {
    let fixture = Fixture::new("replaced");
    let (path, directory) = fixture.directory("directory");
    let parked = fixture.0.join("parked");
    fs::rename(&path, &parked).unwrap();
    assert_eq!(observe_directory_fd(directory.as_raw_fd(), path.to_str().unwrap()).unwrap_err().status, "OBSERVATION_REDIRECTED");
    fs::create_dir(&path).unwrap();
    assert_eq!(observe_directory_fd(directory.as_raw_fd(), path.to_str().unwrap()).unwrap_err().status, "OBSERVATION_REDIRECTED");
    assert_eq!(observe_directory_fd(directory.as_raw_fd(), parked.to_str().unwrap()).unwrap().real_path, parked.to_str().unwrap());
}

#[test]
fn named_observation_does_not_follow_a_symlink_inserted_after_handle_resolution() {
    let fixture = Fixture::new("nofollow");
    let (path, directory) = fixture.directory("directory");
    let parked = fixture.0.join("parked");
    let observed = observe_directory_fd_with(directory.as_raw_fd(), path.to_str().unwrap(), || {
        fs::rename(&path, &parked).unwrap();
        symlink(&parked, &path).unwrap();
        let named = inspect_named_directory(path.to_str().unwrap());
        fs::remove_file(&path).unwrap();
        fs::rename(&parked, &path).unwrap();
        named
    });
    assert_eq!(observed.unwrap_err().status, "path-mismatch");
    directory.metadata().unwrap();
}

#[test]
fn final_handle_path_detects_rename_after_named_observation() {
    let fixture = Fixture::new("final-path");
    let (path, directory) = fixture.directory("directory");
    let parked = fixture.0.join("parked");
    let observed = observe_directory_fd_with(directory.as_raw_fd(), path.to_str().unwrap(), || {
        let named = inspect_named_directory(path.to_str().unwrap())?;
        fs::rename(&path, &parked).unwrap();
        fs::create_dir(&path).unwrap();
        Ok(named)
    });
    assert_eq!(observed.unwrap_err().status, "path-mismatch");
    directory.metadata().unwrap();
}

#[test]
fn metadata_changes_on_either_side_of_named_observation_are_rejected() {
    for after_named in [false, true] {
        for change_mode in [false, true] {
            let fixture = Fixture::new("metadata-change");
            let (path, directory) = fixture.directory("directory");
            let change = || {
                if change_mode {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
                } else {
                    fs::create_dir(path.join("child")).unwrap();
                }
            };
            let observed = observe_directory_fd_with(directory.as_raw_fd(), path.to_str().unwrap(), || {
                if !after_named { change(); }
                let named = inspect_named_directory(path.to_str().unwrap())?;
                if after_named { change(); }
                Ok(named)
            });
            assert_eq!(observed.unwrap_err().status, "path-mismatch");
            directory.metadata().unwrap();
        }
    }
}

#[test]
fn literal_deleted_suffix_is_live_until_the_directory_is_unlinked() {
    let fixture = Fixture::new("literal-deleted");
    let (path, directory) = fixture.directory("directory (deleted)");
    assert_eq!(observe_directory_fd(directory.as_raw_fd(), path.to_str().unwrap()).unwrap().real_path, path.to_str().unwrap());
    fs::remove_dir(&path).unwrap();
    assert_eq!(observe_directory_fd(directory.as_raw_fd(), path.to_str().unwrap()).unwrap_err().status, "path-mismatch");
    directory.metadata().unwrap();
}
