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
