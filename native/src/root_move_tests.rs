use super::*;
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};
use std::os::unix::fs::{MetadataExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("fs-safe-root-move-{}-{}-{sequence}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(path.join("parent")).unwrap();
        fs::create_dir_all(path.join("outside")).unwrap();
        fs::write(path.join("parent/source"), b"inside").unwrap();
        fs::write(path.join("outside/target"), b"outside").unwrap();
        Self(path)
    }
    fn identity(&self) -> ExactFileIdentity {
        let stat = fs::symlink_metadata(self.0.join("parent/source")).unwrap();
        ExactFileIdentity { dev: stat.dev(), ino: stat.ino() }
    }
}
impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }

#[test]
fn replacement_rename_stays_in_retained_parent_after_symlink_swap() {
    let fixture = Fixture::new();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    let expected = fixture.identity();
    fs::rename(fixture.0.join("parent"), fixture.0.join("held")).unwrap();
    symlink("outside", fixture.0.join("parent")).unwrap();
    rename_replace_with_identity(parent.as_raw_fd(), "source", parent.as_raw_fd(), "target", expected).unwrap();
    assert_eq!(fs::read(fixture.0.join("outside/target")).unwrap(), b"outside");
    assert_eq!(fs::read(fixture.0.join("held/target")).unwrap(), b"inside");
}

#[test]
fn replaced_source_is_rejected_before_overwriting_destination() {
    let fixture = Fixture::new();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    fs::write(fixture.0.join("parent/target"), b"preserve").unwrap();
    let expected = fixture.identity();
    fs::rename(fixture.0.join("parent/source"), fixture.0.join("held-source")).unwrap();
    fs::write(fixture.0.join("parent/source"), b"replacement").unwrap();
    let error = rename_replace_with_identity(parent.as_raw_fd(), "source", parent.as_raw_fd(), "target", expected).unwrap_err();
    assert_eq!(error.status, "path-mismatch");
    assert_eq!(fs::read(fixture.0.join("parent/target")).unwrap(), b"preserve");
}

#[test]
fn overwrite_moves_files_and_directories_and_unlinks_destination_links() {
    let fixture = Fixture::new();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    symlink("../outside/target", fixture.0.join("parent/target")).unwrap();
    rename_replace_with_identity(parent.as_raw_fd(), "source", parent.as_raw_fd(), "target", fixture.identity()).unwrap();
    assert_eq!(fs::read(fixture.0.join("outside/target")).unwrap(), b"outside");
    fs::create_dir(fixture.0.join("parent/source")).unwrap();
    fs::create_dir(fixture.0.join("parent/empty")).unwrap();
    rename_replace_with_identity(parent.as_raw_fd(), "source", parent.as_raw_fd(), "empty", fixture.identity()).unwrap();
    assert!(fixture.0.join("parent/empty").is_dir());
}
