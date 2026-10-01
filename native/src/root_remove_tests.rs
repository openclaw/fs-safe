use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use crate::test_support::temp_path;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = temp_path("root-remove");
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn identity(&self, name: &str) -> ExactFileIdentity {
        use std::os::unix::fs::MetadataExt;
        let stat = fs::symlink_metadata(self.0.join(name)).unwrap();
        ExactFileIdentity { dev: stat.dev(), ino: stat.ino() }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
}

#[test]
fn unlink_removes_files_links_and_empty_directories_without_following_links() {
    let fixture = Fixture::new();
    let parent = fs::File::open(&fixture.0).unwrap();
    fs::write(fixture.0.join("outside"), b"preserved").unwrap();
    symlink("outside", fixture.0.join("link")).unwrap();
    fs::create_dir(fixture.0.join("directory")).unwrap();
    fs::write(fixture.0.join("file"), b"remove").unwrap();
    for (name, directory) in [("file", false), ("link", false), ("directory", true)] {
        unlink_entry(parent.as_raw_fd(), name, fixture.identity(name), directory).unwrap();
        assert!(fs::symlink_metadata(fixture.0.join(name)).is_err());
    }
    assert_eq!(fs::read(fixture.0.join("outside")).unwrap(), b"preserved");
}

#[test]
fn swapped_entry_is_rejected_before_unlink() {
    let fixture = Fixture::new();
    let parent = fs::File::open(&fixture.0).unwrap();
    fs::write(fixture.0.join("file"), b"original").unwrap();
    let expected = fixture.identity("file");
    fs::rename(fixture.0.join("file"), fixture.0.join("held")).unwrap();
    fs::write(fixture.0.join("file"), b"replacement").unwrap();
    let error = unlink_entry(parent.as_raw_fd(), "file", expected, false).unwrap_err();
    assert_eq!(error.status, "path-mismatch");
    assert_eq!(fs::read(fixture.0.join("file")).unwrap(), b"replacement");
}

#[test]
fn parent_symlink_swap_cannot_redirect_unlink() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("parent")).unwrap();
    fs::create_dir(fixture.0.join("outside")).unwrap();
    fs::write(fixture.0.join("parent/file"), b"remove").unwrap();
    fs::write(fixture.0.join("outside/file"), b"preserved").unwrap();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    let expected = fixture.identity("parent/file");
    fs::rename(fixture.0.join("parent"), fixture.0.join("held")).unwrap();
    symlink("outside", fixture.0.join("parent")).unwrap();
    unlink_entry(parent.as_raw_fd(), "file", expected, false).unwrap();
    assert_eq!(fs::read(fixture.0.join("outside/file")).unwrap(), b"preserved");
    assert!(!fixture.0.join("held/file").exists());
}

#[test]
fn directory_stream_remains_pinned_after_name_swap() {
    let fixture = Fixture::new();
    let parent = fs::File::open(&fixture.0).unwrap();
    fs::create_dir(fixture.0.join("tree")).unwrap();
    fs::write(fixture.0.join("tree/inside"), b"inside").unwrap();
    let mut directory = open_directory(parent.as_raw_fd(), "tree", fixture.identity("tree")).unwrap();
    fs::rename(fixture.0.join("tree"), fixture.0.join("held")).unwrap();
    fs::create_dir(fixture.0.join("tree")).unwrap();
    fs::write(fixture.0.join("tree/replacement"), b"replacement").unwrap();
    assert_eq!(directory.read_name().unwrap().as_deref(), Some("inside"));
    assert_eq!(directory.read_name().unwrap(), None);
}

#[test]
fn directory_symlink_swap_is_rejected_before_descent() {
    let fixture = Fixture::new();
    let parent = fs::File::open(&fixture.0).unwrap();
    fs::create_dir(fixture.0.join("tree")).unwrap();
    fs::create_dir(fixture.0.join("outside")).unwrap();
    let expected = fixture.identity("tree");
    fs::rename(fixture.0.join("tree"), fixture.0.join("held")).unwrap();
    symlink("outside", fixture.0.join("tree")).unwrap();
    let result = open_directory(parent.as_raw_fd(), "tree", expected);
    assert!(result.is_err());
}

#[test]
fn direct_child_operations_reject_escape_names_and_negative_descriptors() {
    let fixture = Fixture::new();
    let parent = fs::File::open(&fixture.0).unwrap();
    let identity = ExactFileIdentity { dev: 1, ino: 1 };
    for name in ["", ".", "..", "child/file", "/absolute", "nul\0name"] {
        assert!(unlink_entry(parent.as_raw_fd(), name, identity, false).is_err());
    }
    assert_eq!(inspect(-1, "file").unwrap_err().status, "EBADF");
}
