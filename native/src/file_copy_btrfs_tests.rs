use super::*;
use crate::test_support::{
    deny_ficlone_with_errno, deny_ioctl_with_errno, isolated_admission_test, temp_path,
};
use rustix::fs::{IFlags, ioctl_getflags, ioctl_setflags};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

struct Fixture {
    path: PathBuf,
    source: File,
    parent: File,
    source_flags: IFlags,
    parent_flags: IFlags,
    source_identity: (u64, u64),
}

impl Fixture {
    fn new(source_nocow: bool, parent_nocow: bool) -> Self {
        let path = temp_path("btrfs-copy");
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("destination")).unwrap();
        let parent = File::open(path.join("destination")).unwrap();
        assert_eq!(
            rustix::fs::fstatfs(&parent).unwrap().f_type as u64,
            0x9123_683e,
            "run ignored Btrfs tests with TMPDIR on a private Btrfs mount"
        );
        let mut parent_flags = ioctl_getflags(&parent).unwrap();
        parent_flags.set(IFlags::NOCOW, parent_nocow);
        ioctl_setflags(&parent, parent_flags).unwrap();
        let mut source = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path.join("source"))
            .unwrap();
        let mut source_flags = ioctl_getflags(&source).unwrap();
        source_flags.set(IFlags::NOCOW, source_nocow);
        source_flags.insert(IFlags::NODUMP);
        ioctl_setflags(&source, source_flags).unwrap();
        source.write_all(&vec![0x5a; 128 * 1024]).unwrap();
        let stat = source.metadata().unwrap();
        Self {
            path,
            source,
            parent,
            source_flags,
            parent_flags,
            source_identity: (stat.dev(), stat.ino()),
        }
    }

    fn task(&self, mode: CloneMode) -> FileCopyTask {
        prepare_file_copy(
            self.source.as_raw_fd(),
            self.parent.as_raw_fd(),
            "stage".into(),
            match mode {
                CloneMode::Never => "never",
                CloneMode::Auto => "auto",
                CloneMode::Always => "always",
            }
            .into(),
            None,
            None,
        )
        .unwrap()
    }

    fn stage(&self) -> PathBuf {
        self.path.join("destination/stage")
    }

    fn assert_source_and_parent(&self) {
        assert_eq!(ioctl_getflags(&self.source).unwrap(), self.source_flags);
        assert_eq!(ioctl_getflags(&self.parent).unwrap(), self.parent_flags);
        let stat = self.source.metadata().unwrap();
        assert_eq!((stat.dev(), stat.ino()), self.source_identity);
        assert_eq!(
            fs::read(self.path.join("source")).unwrap(),
            vec![0x5a; 128 * 1024]
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn implicit_publication_clone_keeps_inherited_policy() {
    for source_nocow in [false, true] {
        let fixture = Fixture::new(source_nocow, !source_nocow);
        let error = crate::unix::clone_file_exclusive(
            fixture.source.as_raw_fd(),
            fixture.parent.as_raw_fd(),
            "stage",
        )
        .unwrap_err();
        assert_eq!(error.status, "ENOTSUP");
        assert!(!fixture.stage().exists());
        fixture.assert_source_and_parent();
    }
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn preparation_preserves_unrelated_destination_flags() {
    for source_nocow in [false, true] {
        let fixture = Fixture::new(source_nocow, !source_nocow);
        let target =
            crate::unix::create_exclusive_target(fixture.parent.as_raw_fd(), "stage").unwrap();
        let inherited = ioctl_getflags(&target).unwrap() | IFlags::NODUMP;
        ioctl_setflags(&target, inherited).unwrap();
        crate::file_clone_linux::prepare_nocow(
            borrowed(fixture.source.as_raw_fd()),
            &target,
            fixture.parent.as_raw_fd(),
            "stage",
        )
        .unwrap();
        let mut expected = inherited;
        expected.set(IFlags::NOCOW, source_nocow);
        assert_eq!(ioctl_getflags(&target).unwrap(), expected);
        fixture.assert_source_and_parent();
    }
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn explicit_clone_matches_both_nocow_directions_without_changing_source() {
    for source_nocow in [false, true] {
        for mode in [CloneMode::Auto, CloneMode::Always, CloneMode::Never] {
            let fixture = Fixture::new(source_nocow, !source_nocow);
            let created = fixture.task(mode).copy().unwrap();
            assert!(created.error.is_none());
            assert_eq!(
                created.method,
                if mode == CloneMode::Never {
                    "copy"
                } else {
                    "clone"
                }
            );
            let target_flags = ioctl_getflags(created.fd()).unwrap();
            assert_eq!(
                target_flags.contains(IFlags::NOCOW),
                if mode == CloneMode::Never {
                    !source_nocow
                } else {
                    source_nocow
                }
            );
            assert!(
                !target_flags.contains(IFlags::NODUMP),
                "source flags must not be copied wholesale"
            );
            let stat = fs::metadata(fixture.stage()).unwrap();
            assert_ne!((stat.dev(), stat.ino()), fixture.source_identity);
            assert_eq!(fs::read(fixture.stage()).unwrap(), vec![0x5a; 128 * 1024]);
            rustix::io::pwrite(created.fd(), b"x", 0).unwrap();
            fixture.assert_source_and_parent();
            drop(created);
            assert!(!fixture.stage().exists());
        }
    }
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn clone_refusal_recreates_parent_policy_in_both_directions() {
    isolated_admission_test(
        "file_copy::btrfs_tests::clone_refusal_recreates_parent_policy_in_both_directions",
        || {
            deny_ficlone_with_errno(libc::EOPNOTSUPP);
            for source_nocow in [false, true] {
                for mode in [CloneMode::Auto, CloneMode::Always] {
                    let fixture = Fixture::new(source_nocow, !source_nocow);
                    let result = fixture.task(mode).copy();
                    if mode == CloneMode::Auto {
                        let created = result.unwrap();
                        assert!(created.error.is_none());
                        assert_ne!(created.method, "clone");
                        assert_eq!(
                            ioctl_getflags(created.fd())
                                .unwrap()
                                .contains(IFlags::NOCOW),
                            !source_nocow
                        );
                        assert_eq!(fs::read(fixture.stage()).unwrap(), vec![0x5a; 128 * 1024]);
                        drop(created);
                    } else {
                        assert_eq!(result.err().unwrap().status, "ENOTSUP");
                    }
                    assert!(!fixture.stage().exists());
                    fixture.assert_source_and_parent();
                }
            }
        },
    );
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn denied_preparation_preserves_auto_fallback_and_strict_refusal() {
    isolated_admission_test(
        "file_copy::btrfs_tests::denied_preparation_preserves_auto_fallback_and_strict_refusal",
        || {
            let fixture = Fixture::new(true, false);
            deny_ioctl_with_errno(libc::FS_IOC_SETFLAGS as u32, libc::EPERM);
            let created = fixture.task(CloneMode::Auto).copy().unwrap();
            assert!(created.error.is_none());
            assert_ne!(created.method, "clone");
            assert!(
                !ioctl_getflags(created.fd())
                    .unwrap()
                    .contains(IFlags::NOCOW)
            );
            drop(created);
            assert_eq!(
                fixture.task(CloneMode::Always).copy().err().unwrap().status,
                "ENOTSUP"
            );
            assert!(!fixture.stage().exists());
            fixture.assert_source_and_parent();
        },
    );
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn preparation_io_failure_is_terminal_and_cleans_target() {
    isolated_admission_test(
        "file_copy::btrfs_tests::preparation_io_failure_is_terminal_and_cleans_target",
        || {
            let fixture = Fixture::new(true, false);
            deny_ioctl_with_errno(libc::FS_IOC_SETFLAGS as u32, libc::EIO);
            let error = fixture.task(CloneMode::Auto).copy().err().unwrap();
            assert_eq!(error.status, "EIO");
            assert!(error.reason.contains("set clone target NOCOW"));
            assert!(!fixture.stage().exists());
            fixture.assert_source_and_parent();
        },
    );
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn successful_setflags_without_matching_readback_is_terminal() {
    isolated_admission_test(
        "file_copy::btrfs_tests::successful_setflags_without_matching_readback_is_terminal",
        || {
            let fixture = Fixture::new(true, false);
            // SECCOMP_RET_ERRNO with zero suppresses the syscall but reports success.
            deny_ioctl_with_errno(libc::FS_IOC_SETFLAGS as u32, 0);
            let error = fixture.task(CloneMode::Auto).copy().err().unwrap();
            assert_eq!(error.status, "EIO");
            assert!(error.reason.contains("did not match requested policy"));
            assert!(!fixture.stage().exists());
            fixture.assert_source_and_parent();
        },
    );
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn inherited_compression_is_not_cleared_to_force_nocow() {
    let fixture = Fixture::new(true, false);
    let compressed = fixture.parent_flags | IFlags::COMPRESSED;
    ioctl_setflags(&fixture.parent, compressed).unwrap();
    let created = fixture.task(CloneMode::Auto).copy().unwrap();
    assert!(created.error.is_none());
    assert_ne!(created.method, "clone");
    let flags = ioctl_getflags(created.fd()).unwrap();
    assert!(flags.contains(IFlags::COMPRESSED));
    assert!(!flags.contains(IFlags::NOCOW));
    drop(created);
    assert_eq!(
        fixture.task(CloneMode::Always).copy().err().unwrap().status,
        "ENOTSUP"
    );
    assert!(!fixture.stage().exists());
    assert_eq!(ioctl_getflags(&fixture.parent).unwrap(), compressed);
    ioctl_setflags(&fixture.parent, fixture.parent_flags).unwrap();
    fixture.assert_source_and_parent();
}

#[test]
#[ignore = "requires a private Btrfs TMPDIR"]
fn post_clone_mode_failure_is_not_an_automatic_copy_fallback() {
    isolated_admission_test(
        "file_copy::btrfs_tests::post_clone_mode_failure_is_not_an_automatic_copy_fallback",
        || {
            let fixture = Fixture::new(true, false);
            crate::test_support::deny_syscall_with_errno(libc::SYS_fchmod, libc::EOPNOTSUPP);
            let error = fixture.task(CloneMode::Auto).copy().err().unwrap();
            assert_eq!(error.status, "EIO");
            assert!(error.reason.contains("normalize cloned file"));
            assert!(!fixture.stage().exists());
            fixture.assert_source_and_parent();
        },
    );
}
