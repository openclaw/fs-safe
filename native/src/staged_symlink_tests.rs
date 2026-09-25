use super::*;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("fs-safe-symlink-{}-{stamp}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn retained_handle_has_only_metadata_authority_and_pins_unlinked_inode() {
    let fixture = Fixture::new();
    let parent = std::fs::File::open(&fixture.0).unwrap();
    std::os::unix::fs::symlink("target", fixture.0.join("stage")).unwrap();
    // SAFETY: open returns a fresh descriptor owned by this test.
    let held = unsafe { OwnedFd::from_raw_fd(open(parent.as_raw_fd(), "stage").unwrap()) };
    let flags = rustix::fs::fcntl_getfl(&held).unwrap();
    #[cfg(target_os = "macos")]
    assert!(flags.contains(OFlags::from_bits_retain(libc::O_EVTONLY as u32)));
    #[cfg(target_os = "linux")]
    assert!(flags.contains(OFlags::PATH));
    assert!(rustix::io::fcntl_getfd(&held).unwrap().contains(rustix::io::FdFlags::CLOEXEC));
    let before = rustix::fs::fstat(&held).unwrap();
    assert!(FileType::from_raw_mode(before.st_mode).is_symlink());
    std::fs::remove_file(fixture.0.join("stage")).unwrap();
    std::os::unix::fs::symlink("target", fixture.0.join("stage")).unwrap();
    assert!(!matches(parent.as_raw_fd(), "stage", held.as_raw_fd()).unwrap());
    let retained = rustix::fs::fstat(&held).unwrap();
    assert_eq!((retained.st_dev, retained.st_ino), (before.st_dev, before.st_ino));
    assert_eq!(retained.st_nlink, 0);
}

#[test]
fn observed_fifo_is_rejected_without_changing_it() {
    let fixture = Fixture::new();
    let parent = std::fs::File::open(&fixture.0).unwrap();
    assert!(std::process::Command::new("mkfifo").args(["-m", "600"])
        .arg(fixture.0.join("stage")).status().unwrap().success());
    let before = rustix::fs::statat(&parent, "stage", AtFlags::SYMLINK_NOFOLLOW).unwrap();
    assert_eq!(open(parent.as_raw_fd(), "stage").unwrap_err().status, "EINVAL");
    let after = rustix::fs::statat(&parent, "stage", AtFlags::SYMLINK_NOFOLLOW).unwrap();
    assert_eq!((after.st_dev, after.st_ino, after.st_mode), (before.st_dev, before.st_ino, before.st_mode));
    assert!(FileType::from_raw_mode(after.st_mode).is_fifo());
}
