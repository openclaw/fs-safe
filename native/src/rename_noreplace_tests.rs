use std::fs::{self, File};
use std::os::fd::AsRawFd;
use crate::unix;

fn deny_noreplace(error: i32) {
    let flags = std::mem::offset_of!(libc::seccomp_data, args) + 4 * 8;
    let flags = if cfg!(target_endian = "little") { flags } else { flags + 4 };
    let statement = |code: u32, k: u32| libc::sock_filter { code: code as u16, jt: 0, jf: 0, k };
    let jump = |k: u32, jt: u8, jf: u8| libc::sock_filter {
        code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16, jt, jf, k,
    };
    let load = libc::BPF_LD | libc::BPF_W | libc::BPF_ABS;
    let mut filter = [
        statement(load, std::mem::offset_of!(libc::seccomp_data, nr) as u32),
        jump(libc::SYS_renameat2 as u32, 0, 3),
        statement(load, flags as u32),
        jump(libc::RENAME_NOREPLACE, 0, 1),
        statement(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ERRNO | error as u32),
        statement(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ALLOW),
    ];
    let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
    unsafe {
        assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);
        assert_eq!(libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program), 0);
    }
}

#[test]
fn seccomp_unsupported_noreplace_is_definitely_unpublished() {
    const NAME: &str = "rename_noreplace_tests::seccomp_unsupported_noreplace_is_definitely_unpublished";
    const CHILD: &str = "FS_SAFE_RENAME_ADMISSION_TEST";
    let Ok(errno) = std::env::var(CHILD) else {
        for errno in [libc::EINVAL, libc::ENOSYS, libc::EOPNOTSUPP] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([NAME, "--exact", "--test-threads=1"])
                .env(CHILD, errno.to_string()).output().unwrap();
            assert!(output.status.success(), "isolated admission check failed: {}\n{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
        return;
    };
    let directory = std::env::temp_dir().join(format!("fs-safe-rename-seccomp-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    fs::create_dir(directory.join("nested")).unwrap();
    let parent = File::open(&directory).unwrap();
    deny_noreplace(errno.parse().unwrap());
    for prefix in ["", "nested/"] {
        let source = format!("{prefix}source");
        let target = format!("{prefix}target");
        fs::write(directory.join(&source), b"unpublished").unwrap();
        let error = unix::rename_no_replace(parent.as_raw_fd(), &source, parent.as_raw_fd(), &target).unwrap_err();
        assert_eq!(error.status, "FS_SAFE_INTERNAL_RENAME_NOREPLACE_UNSUPPORTED");
        assert!(error.reason.contains("renameat2 RENAME_NOREPLACE"));
        assert_eq!(fs::read(directory.join(&source)).unwrap(), b"unpublished");
        assert!(!directory.join(&target).exists());
        // Only NOREPLACE is denied; ordinary replacement must still work.
        unix::rename_replace(parent.as_raw_fd(), &source, parent.as_raw_fd(), &target).unwrap();
    }
    fs::remove_dir_all(directory).unwrap();
}
