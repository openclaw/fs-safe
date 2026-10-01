use std::{fs, path::PathBuf};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{symlink, MetadataExt, OpenOptionsExt};
use crate::test_support::temp_path;
use crate::unix::{mkdir_child_beneath, mkdir_open_child_beneath, open_create_beneath};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = temp_path("root-create");
        fs::create_dir_all(path.join("parent")).unwrap();
        fs::create_dir_all(path.join("outside")).unwrap();
        Self(path)
    }
    fn before_final(&self) {
        fs::rename(self.0.join("parent"), self.0.join("held")).unwrap();
        symlink("outside", self.0.join("parent")).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }

#[test]
fn mkdir_pins_parent_and_reports_only_its_exclusive_creation() {
    let fixture = Fixture::new();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    fixture.before_final();
    assert!(mkdir_child_beneath(parent.as_raw_fd(), "child", 0o700).unwrap());
    assert!(!mkdir_child_beneath(parent.as_raw_fd(), "child", 0o700).unwrap());
    assert!(fixture.0.join("held/child").is_dir());
    assert!(!fixture.0.join("outside/child").exists());
}

#[test]
fn fused_mkdir_open_retains_parent_and_rejects_a_link_collision() {
    let fixture = Fixture::new();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    fixture.before_final();
    let (raw, created) = mkdir_open_child_beneath(parent.as_raw_fd(), "child", 0o700, libc::O_RDONLY).unwrap();
    // SAFETY: fused creation transfers one owned directory descriptor.
    let child = unsafe { fs::File::from_raw_fd(raw) };
    assert!(created);
    assert_eq!(child.metadata().unwrap().ino(), fs::metadata(fixture.0.join("held/child")).unwrap().ino());
    assert!(!fixture.0.join("outside/child").exists());
    symlink("../outside", fixture.0.join("held/link")).unwrap();
    assert!(mkdir_open_child_beneath(parent.as_raw_fd(), "link", 0o700, libc::O_RDONLY).is_err());
}

#[test]
fn append_creation_pins_parent_and_does_not_follow_a_final_symlink() {
    let fixture = Fixture::new();
    let parent = fs::File::open(fixture.0.join("parent")).unwrap();
    fixture.before_final();
    let flags = libc::O_RDWR | libc::O_APPEND | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW;
    // SAFETY: the creation helper transfers a fresh owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(open_create_beneath(parent.as_raw_fd(), "created", flags, 0o640).unwrap()) };
    use std::io::Write;
    let mut file = fs::File::from(fd);
    file.write_all(b"inside").unwrap();
    let control = fs::OpenOptions::new().write(true).create_new(true).mode(0o640)
        .open(fixture.0.join("held/control")).unwrap();
    assert_eq!(file.metadata().unwrap().mode() & 0o7777, control.metadata().unwrap().mode() & 0o7777);
    assert_eq!(fs::read(fixture.0.join("held/created")).unwrap(), b"inside");
    assert!(!fixture.0.join("outside/created").exists());
    fs::write(fixture.0.join("outside/value"), b"preserve").unwrap();
    symlink("../outside/value", fixture.0.join("held/link")).unwrap();
    assert!(open_create_beneath(parent.as_raw_fd(), "link", flags, 0o640).is_err());
    assert_eq!(fs::read(fixture.0.join("outside/value")).unwrap(), b"preserve");
}
