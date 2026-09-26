use super::*;
use std::{fs, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Memory::*;
use crate::windows::{open_existing_handle, handle_identity_and_size, win_error};

struct Fixture { directory: PathBuf, file: PathBuf }
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!("fs-safe-retained-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&directory).unwrap();
        let directory = fs::canonicalize(directory).unwrap();
        let file = directory.join("backup");
        fs::write(&file, b"original").unwrap();
        Self { directory, file }
    }
    fn retain(&self) -> NativeRetainedFile {
        let (pd, pi, _, _, _) = facts(&self.directory);
        let (d, i, s, m, c) = facts(&self.file);
        retain_windows_file(self.directory.to_string_lossy().trim_start_matches(r"\\?\").into(), "backup".into(),
            pd.into(), pi.into(), d.into(), i.into(), s.into(), m.into(), c.into(),
            "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5".into(), 1024)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { fs::remove_dir_all(&self.directory).expect("settled fixture cleanup"); }
}
fn facts(path: &Path) -> (u64, u64, u64, u64, u64) {
    let wide: Vec<_> = path.to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let h = open_existing_handle(&wide, FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        |e| win_error(e, "test facts")).unwrap();
    let ((d, i, _), size) = handle_identity_and_size(h.0).unwrap();
    let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
    assert_ne!(unsafe { GetFileInformationByHandleEx(h.0, FileBasicInfo, (&mut basic as *mut FILE_BASIC_INFO).cast(), size_of::<FILE_BASIC_INFO>() as u32) }, 0);
    h.close().unwrap();
    let epoch = 11644473600000000000i128;
    (d as u64, i, size, (basic.LastWriteTime as i128 * 100 - epoch) as u64, (basic.ChangeTime as i128 * 100 - epoch) as u64)
}
fn assert_retained(owner: &NativeRetainedFile) {
    assert_eq!(owner.result.status, "retained", "{:?}", owner.result.errors.iter().map(|e| (&e.code, &e.message)).collect::<Vec<_>>());
}

#[test]
fn explicit_disposition_and_duplicate_calls_preserve_replacement() {
    let f = Fixture::new();
    let mut owner = f.retain(); assert_retained(&owner);
    let result = owner.settle(true);
    assert_eq!(result.status, "name-absent-after-settlement");
    assert_eq!(result.resources, "closed");
    assert_eq!(result.persistence, "not-proven");
    assert!(result.errors.is_empty());
    assert!(!f.file.exists());
    fs::write(&f.file, b"replacement").unwrap();
    assert_eq!(owner.settle(true).status, result.status);
    assert_eq!(fs::read(&f.file).unwrap(), b"replacement");
}

#[test]
fn handle_sharing_prevents_in_place_write_and_name_swaps_until_dispose() {
    let f = Fixture::new();
    let mut owner = f.retain(); assert_retained(&owner);
    assert!(fs::write(&f.file, b"newer").is_err());
    assert!(fs::rename(&f.file, f.directory.join("moved")).is_err());
    assert!(fs::rename(&f.directory, f.directory.with_extension("moved")).is_err());
    let result = owner.settle(false);
    assert_eq!(result.status, "not-attempted");
    assert_eq!(result.resources, "closed");
    fs::write(&f.file, b"newer").unwrap();
    assert_eq!(fs::read(&f.file).unwrap(), b"newer");
}

#[test]
fn foreign_open_writer_refuses_admission_without_closing_foreign_handle() {
    let f = Fixture::new();
    let writer = fs::OpenOptions::new().write(true).open(&f.file).unwrap();
    let owner = f.retain();
    assert_ne!(owner.result.status, "retained");
    assert_eq!(owner.result.resources, "closed");
    writer.set_len(5).unwrap();
    drop(writer);
    assert_eq!(fs::read(&f.file).unwrap(), b"origi");
}

#[test]
fn a_reader_can_outlive_settled_namespace_absence() {
    use std::io::Read;
    let f = Fixture::new();
    let mut owner = f.retain(); assert_retained(&owner);
    let mut reader = fs::File::open(&f.file).unwrap();
    let result = owner.settle(true);
    assert_eq!(result.status, "name-absent-after-settlement");
    let mut bytes = Vec::new(); reader.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"original");
    drop(reader);
}

#[test]
fn writable_mapping_without_writer_handle_is_refused() {
    let f = Fixture::new();
    let wide: Vec<_> = f.file.to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let file = unsafe { CreateFileW(wide.as_ptr(), FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING, 0, null_mut()) };
    assert_ne!(file, INVALID_HANDLE_VALUE);
    let mapping = unsafe { CreateFileMappingW(file, null(), PAGE_READWRITE, 0, 0, null()) };
    assert!(!mapping.is_null());
    let view = unsafe { MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 8) };
    assert!(!view.Value.is_null());
    assert_ne!(unsafe { CloseHandle(file) }, 0);
    let owner = f.retain();
    assert_ne!(owner.result.status, "retained");
    assert_eq!(owner.result.disposition, "not-attempted");
    assert_eq!(owner.result.resources, "closed");
    // A real mapped write is the causal control, not merely an unused mapping.
    unsafe { std::ptr::copy_nonoverlapping(b"new-data".as_ptr(), view.Value.cast(), 8); }
    assert_ne!(unsafe { FlushViewOfFile(view.Value, 8) }, 0);
    assert_ne!(unsafe { UnmapViewOfFile(view) }, 0);
    assert_ne!(unsafe { CloseHandle(mapping) }, 0);
    assert_eq!(fs::read(&f.file).unwrap(), b"new-data");
}

#[test]
fn named_streams_are_preserved_including_streams_added_during_retention() {
    let f = Fixture::new();
    let mut owner = f.retain(); assert_retained(&owner);
    let stream = PathBuf::from(format!("{}:newer", f.file.display()));
    match fs::write(&stream, b"foreign-stream") {
        Ok(()) => {
            let result = owner.settle(true);
            assert_ne!(result.disposition, "accepted");
            assert_eq!(fs::read(&stream).unwrap(), b"foreign-stream");
            assert_eq!(fs::read(&f.file).unwrap(), b"original");
        },
        Err(_) => { assert_eq!(owner.settle(false).resources, "closed"); },
    }
}

#[test]
fn reparse_parent_is_not_followed() {
    let f = Fixture::new();
    let alias = f.directory.join("alias");
    // Junctions do not need symbolic-link privilege on the Windows CI account.
    let status = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"])
        .arg(&alias).arg(&f.directory).output().unwrap();
    assert!(status.status.success(), "junction fixture creation failed");
    let (pd, pi, _, _, _) = facts(&f.directory);
    let (d, i, s, m, c) = facts(&f.file);
    let owner = retain_windows_file(alias.to_string_lossy().trim_start_matches(r"\\?\").into(), "backup".into(),
        pd.into(), pi.into(), d.into(), i.into(), s.into(), m.into(), c.into(),
        "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5".into(), 1024);
    assert_ne!(owner.result.status, "retained");
    assert_eq!(owner.result.resources, "closed");
    fs::remove_dir(&alias).unwrap();
    assert_eq!(fs::read(&f.file).unwrap(), b"original");
}

#[test]
fn close_uncertainty_retains_operation_and_close_errors_without_retry() {
    let f = Fixture::new();
    let mut owner = f.retain(); assert_retained(&owner);
    let file = owner.owner.as_mut().unwrap().file.as_mut().unwrap();
    assert_ne!(unsafe { CloseHandle(file.0) }, 0);
    // Fault injection substitutes a guaranteed-invalid value, never a recycled handle.
    file.0 = INVALID_HANDLE_VALUE;
    let result = owner.settle(true);
    assert_eq!(result.status, "indeterminate");
    assert_eq!(result.resources, "close-failed");
    assert!(result.errors.iter().any(|e| e.phase == "verify"));
    assert!(result.errors.iter().any(|e| e.phase == "close-file"));
    let foreign = fs::File::open(&f.file).unwrap();
    assert_eq!(owner.settle(true).errors.len(), result.errors.len());
    assert_eq!(foreign.metadata().unwrap().len(), 8);
    drop(foreign);
}
