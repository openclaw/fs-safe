use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn unique_path_in(base: &Path, label: &str) -> PathBuf {
    static NEXT_PATH: AtomicU64 = AtomicU64::new(0);
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let sequence = NEXT_PATH.fetch_add(1, Ordering::Relaxed);
    base.join(format!("fs-safe-{label}-{}-{nonce}-{sequence}", std::process::id()))
}

pub(crate) fn temp_path(label: &str) -> PathBuf {
    unique_path_in(&std::env::temp_dir(), label)
}

#[cfg(windows)]
pub(crate) fn directory(path: &Path) -> std::fs::File {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .unwrap()
}

#[cfg(unix)]
pub(crate) fn isolated_admission_test(name: &str, check: impl FnOnce()) {
    const CHILD_TEST: &str = "FS_SAFE_COPY_ADMISSION_TEST";
    if std::env::var(CHILD_TEST).as_deref() == Ok(name) {
        let limits = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // A baseline regression can panic before syscall validation.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limits) }, 0);
        check();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--test-threads=1"])
        .env(CHILD_TEST, name)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "isolated admission check failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[cfg(target_os = "linux")]
pub(crate) fn deny_ficlone_with_eperm() {
    // Mirror container seccomp profiles: ioctl(FICLONE) fails with EPERM
    // before any filesystem sees it; every other syscall is allowed.
    let request = std::mem::offset_of!(libc::seccomp_data, args) + 8;
    let request = if cfg!(target_endian = "little") {
        request
    } else {
        request + 4
    };
    let statement = |code: u32, k: u32| libc::sock_filter {
        code: code as u16,
        jt: 0,
        jf: 0,
        k,
    };
    let jump = |k: u32, jt: u8, jf: u8| libc::sock_filter {
        code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
        jt,
        jf,
        k,
    };
    let load = libc::BPF_LD | libc::BPF_W | libc::BPF_ABS;
    let mut filter = [
        statement(load, std::mem::offset_of!(libc::seccomp_data, nr) as u32),
        jump(libc::SYS_ioctl as u32, 0, 3),
        statement(load, request as u32),
        jump(libc::FICLONE as u32, 0, 1),
        statement(
            libc::BPF_RET | libc::BPF_K,
            libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
        ),
        statement(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ALLOW),
    ];
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    unsafe {
        assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);
        assert_eq!(
            libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program),
            0
        );
    }
}
