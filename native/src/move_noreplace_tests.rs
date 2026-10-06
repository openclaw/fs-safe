use std::fs::{self, File};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::Path;
use crate::{ExactFileIdentity, move_noreplace, rename_noreplace_tests::deny_noreplace, unix};

fn deny_syscall(syscall: libc::c_long, errno: i32) {
    let mut filters = [
        libc::sock_filter { code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            jt: 0, jf: 0, k: std::mem::offset_of!(libc::seccomp_data, nr) as u32 },
        libc::sock_filter { code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            jt: 0, jf: 1, k: syscall as u32 },
        libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0, jf: 0, k: libc::SECCOMP_RET_ERRNO | errno as u32 },
        libc::sock_filter { code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0, jf: 0, k: libc::SECCOMP_RET_ALLOW },
    ];
    let filter = libc::sock_fprog { len: filters.len() as u16, filter: filters.as_mut_ptr() };
    unsafe { assert_eq!(libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &filter), 0); }
}

#[test]
fn seccomp_move_fallback_races_and_partial_states() {
    const NAME: &str = "move_noreplace_tests::seccomp_move_fallback_races_and_partial_states";
    if let Ok(case) = std::env::var("FS_SAFE_MOVE_CASE") {
        run_case(Path::new(&std::env::var("FS_SAFE_MOVE_DIR").unwrap()), &case);
        return;
    }
    let base = std::env::temp_dir().join(format!("fs-safe-move-races-{}", std::process::id()));
    fs::create_dir(&base).unwrap();
    for case in ["directory", "file", "nonempty-race", "file-race", "empty-race",
        "directory-source-file", "directory-source-symlink",
        "link-collision", "source-swap", "source-symlink", "target-swap", "third-link",
        "link-EPERM", "link-EOPNOTSUPP", "link-EMLINK", "link-EXDEV", "unlink-failure",
        "target-removed-after-unlink", "require"] {
        let dir = base.join(case);
        fs::create_dir(&dir).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([NAME, "--exact", "--test-threads=1"])
            .env("FS_SAFE_MOVE_CASE", case).env("FS_SAFE_MOVE_DIR", &dir).output().unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert!(output.status.success(), "{case}: {}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
    fs::remove_dir(base).unwrap();
}

fn run_case(directory: &Path, case: &str) {
    let source = directory.join("source");
    let target = directory.join("target");
    let is_directory = matches!(case, "directory" | "nonempty-race" | "file-race" | "empty-race" |
        "directory-source-file" | "directory-source-symlink");
    if is_directory {
        fs::create_dir(&source).unwrap();
        fs::write(source.join("content"), b"source").unwrap();
    } else { fs::write(&source, b"source").unwrap(); }
    let before = fs::symlink_metadata(&source).unwrap();
    let parent = File::open(directory).unwrap();
    let fd = parent.as_raw_fd();
    deny_noreplace(libc::EINVAL);
    let error = unix::rename_no_replace(fd, "source", fd, "target").unwrap_err();
    assert_eq!(error.status, unix::RENAME_NOREPLACE_UNSUPPORTED);
    if case == "require" {
        // The strict primitive never enters the separately admitted fallback.
        assert!(!target.exists());
        assert_eq!(fs::read(source).unwrap(), b"source");
        return;
    }
    match case {
        "directory-source-file" | "directory-source-symlink" => {
            let source = source.clone();
            let target = target.clone();
            let saved = directory.join("saved");
            let case = case.to_owned();
            move_noreplace::BEFORE_RENAME.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&source, &saved).unwrap();
                if case == "directory-source-file" { fs::write(&source, b"replacement").unwrap(); }
                else { symlink(&saved, &source).unwrap(); }
                fs::write(&target, b"competitor").unwrap();
            })));
        }
        "nonempty-race" | "file-race" | "empty-race" => {
            let target = target.clone();
            let case = case.to_owned();
            move_noreplace::BEFORE_RENAME.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                if case == "file-race" { fs::write(&target, b"competitor").unwrap(); }
                else {
                    fs::create_dir(&target).unwrap();
                    if case == "nonempty-race" { fs::write(target.join("competitor"), b"keep").unwrap(); }
                }
            })));
        }
        "link-collision" => {
            let target = target.clone();
            move_noreplace::BEFORE_LINK.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                fs::write(&target, b"competitor").unwrap();
            })));
        }
        "source-swap" | "source-symlink" | "target-swap" | "third-link" => {
            let source = source.clone();
            let target = target.clone();
            let directory = directory.to_owned();
            let case = case.to_owned();
            move_noreplace::BEFORE_UNLINK.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                if case == "third-link" { fs::hard_link(&target, directory.join("third")).unwrap(); }
                else if case == "target-swap" {
                    fs::rename(&target, directory.join("saved")).unwrap();
                    fs::write(&target, b"competitor").unwrap();
                } else {
                    fs::rename(&source, directory.join("saved")).unwrap();
                    if case == "source-symlink" { symlink(&target, &source).unwrap(); }
                    else { fs::write(&source, b"replacement").unwrap(); }
                }
            })));
        }
        "link-EPERM" => deny_syscall(libc::SYS_linkat, libc::EPERM),
        "link-EOPNOTSUPP" => deny_syscall(libc::SYS_linkat, libc::EOPNOTSUPP),
        "link-EMLINK" => deny_syscall(libc::SYS_linkat, libc::EMLINK),
        "link-EXDEV" => deny_syscall(libc::SYS_linkat, libc::EXDEV),
        "unlink-failure" => deny_syscall(libc::SYS_unlinkat, libc::EACCES),
        "target-removed-after-unlink" => {
            let target = target.clone();
            move_noreplace::AFTER_UNLINK.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                fs::remove_file(target).unwrap();
            })));
        }
        _ => {}
    }
    let result = move_noreplace::move_fallback(fd, "source", fd, "target",
        ExactFileIdentity { dev: before.dev(), ino: before.ino() });
    match case {
        "directory-source-file" | "directory-source-symlink" => {
            assert_eq!(result.unwrap_err().status, "EEXIST");
            assert_eq!(fs::read(target).unwrap(), b"competitor");
            assert_eq!(fs::read(directory.join("saved/content")).unwrap(), b"source");
            if case == "directory-source-file" { assert_eq!(fs::read(source).unwrap(), b"replacement"); }
            else { assert!(fs::symlink_metadata(source).unwrap().is_symlink()); }
        }
        "directory" | "file" | "empty-race" => {
            result.unwrap();
            assert!(!source.exists());
            let after = fs::symlink_metadata(&target).unwrap();
            assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
            if !is_directory { assert_eq!(after.nlink(), 1); }
        }
        "nonempty-race" | "file-race" | "link-collision" => {
            assert_eq!(result.unwrap_err().status, "EEXIST");
            assert_eq!(fs::symlink_metadata(&source).unwrap().ino(), before.ino());
            if case == "nonempty-race" { assert_eq!(fs::read(target.join("competitor")).unwrap(), b"keep"); }
            else { assert_eq!(fs::read(target).unwrap(), b"competitor"); }
        }
        "unlink-failure" => {
            let error = result.unwrap_err();
            assert_eq!(error.status, "FS_SAFE_INTERNAL_MOVE_SOURCE_LINKED");
            assert!(error.reason.contains("source still linked"));
            for name in [source, target] {
                let current = fs::symlink_metadata(name).unwrap();
                assert_eq!((current.ino(), current.nlink()), (before.ino(), 2));
            }
        }
        "target-removed-after-unlink" => {
            let error = result.unwrap_err();
            assert_eq!(error.status, "FS_SAFE_INTERNAL_MOVE_PUBLISHED");
            assert!(error.reason.contains("completed; target verification failed"));
            assert!(!source.exists());
            assert!(!target.exists());
        }
        case if case.starts_with("link-") => {
            let error = result.unwrap_err();
            assert_eq!(error.status, "FS_SAFE_INTERNAL_MOVE_LINK_UNSUPPORTED");
            assert!(error.reason.contains("RENAME_NOREPLACE"));
            assert!(error.reason.contains("linkat"));
            assert!(!target.exists());
            assert_eq!(fs::read(source).unwrap(), b"source");
        }
        _ => {
            assert_eq!(result.unwrap_err().status, "FS_SAFE_INTERNAL_MOVE_LINK_CHANGED");
            assert!(source.symlink_metadata().is_ok());
            assert_eq!(fs::read(&target).unwrap(), if case == "target-swap" { b"competitor".as_slice() } else { b"source".as_slice() });
            if case == "source-swap" { assert_eq!(fs::read(&source).unwrap(), b"replacement"); }
            if case == "source-symlink" { assert!(fs::symlink_metadata(source).unwrap().is_symlink()); }
        }
    }
}
