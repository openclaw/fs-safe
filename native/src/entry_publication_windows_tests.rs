use super::*;
use std::{fs, mem::zeroed, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use windows_sys::Win32::{System::Ioctl::FSCTL_SET_REPARSE_POINT};
use crate::windows::open_existing_handle;
struct Fixture { root: PathBuf, source: PathBuf, target: PathBuf }
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("fs-safe-publication-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap(); let root = fs::canonicalize(root).unwrap();
        let source = root.join("staging"); let target = root.join("target"); fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(source.join("entry"), b"original").unwrap(); Self { root, source, target }
    }
    fn retain(&self, kind: &str) -> NativeWindowsEntryPublication {
        let (sd, si) = facts(&self.source); let (td, ti) = facts(&self.target); let (d, i) = facts(&self.source.join("entry"));
        retain_windows_entry_publication(spelling(&self.source), "entry".into(), sd.into(), si.into(), spelling(&self.target), "entry".into(), td.into(), ti.into(), d.into(), i.into(), kind.into())
    }
}
impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.root).expect("settled publication fixture"); } }
fn spelling(path: &Path) -> String { path.to_str().unwrap().trim_start_matches(r"\\?\").into() }
fn handle(path: &Path, access: u32) -> OwnedHandle {
    let wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
    open_existing_handle(&wide, access, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, |e| win_error(e, "test entry")).unwrap()
}
fn facts(path: &Path) -> (u64, u64) {
    let h = handle(path, FILE_READ_ATTRIBUTES); let ((d, i, _), _) = handle_identity_and_size(h.0).unwrap(); h.close().unwrap(); (d as u64, i)
}
fn admitted(owner: &NativeWindowsEntryPublication) { assert_eq!(owner.admission.outcome, "retained", "{:?}: {:?}", owner.admission.error_code, owner.admission.error_message); }
#[test]
fn native_no_replace_and_close_only_do_not_undo_committed_name() {
    let f = Fixture::new(); let original = facts(&f.source.join("entry")); let mut owner = f.retain("file"); admitted(&owner);
    assert_eq!(owner.publish().outcome, "committed");
    assert_eq!(facts(&f.target.join("entry")), original);
    fs::write(f.source.join("entry"), b"new source").unwrap(); assert_eq!(owner.publish().outcome, "committed");
    assert!(owner.close().is_empty()); assert!(owner.close().is_empty());
    assert_eq!(fs::read(f.source.join("entry")).unwrap(), b"new source"); assert_eq!(fs::read(f.target.join("entry")).unwrap(), b"original");
    let mut next = f.retain("file"); admitted(&next); let result = next.publish();
    assert_eq!(result.outcome, "not-published"); assert_eq!(result.error_code.as_deref(), Some("EEXIST")); assert!(next.close().is_empty());
    assert_eq!(fs::read(f.source.join("entry")).unwrap(), b"new source"); assert_eq!(fs::read(f.target.join("entry")).unwrap(), b"original");
}
#[test]
fn native_source_swap_refuses_and_dispose_never_removes_staging() {
    let f = Fixture::new(); let mut owner = f.retain("file"); admitted(&owner);
    fs::rename(f.source.join("entry"), f.source.join("old")).unwrap(); fs::write(f.source.join("entry"), b"foreign").unwrap();
    let result = owner.publish(); assert_eq!(result.outcome, "not-published"); assert_eq!(result.error_code.as_deref(), Some("path-mismatch"));
    assert!(owner.close().is_empty()); assert_eq!(fs::read(f.source.join("old")).unwrap(), b"original"); assert_eq!(fs::read(f.source.join("entry")).unwrap(), b"foreign");
    assert!(!f.target.join("entry").exists());
}
#[test]
fn every_close_is_consumed_after_a_real_invalid_handle_error() {
    let f = Fixture::new(); let mut owner = f.retain("file"); admitted(&owner);
    // Replace our owned source slot with the permanently invalid sentinel after
    // settling the real handle. NULL cannot alias a live or pseudo handle; -1 is
    // the current-process pseudo handle on Windows. Never retry a recycled value.
    owner.owner.as_mut().unwrap().file.take().unwrap().close().unwrap();
    owner.owner.as_mut().unwrap().file = Some(OwnedHandle(null_mut()));
    let errors = owner.close(); assert_eq!(errors.len(), 1); assert_eq!(owner.close().len(), 1);
    assert!(owner.owner.is_none());
    for directory in [&f.source, &f.target] {
        let wide: Vec<u16> = directory.to_str().unwrap().encode_utf16().chain(Some(0)).collect();
        let h = unsafe { CreateFileW(wide.as_ptr(), FILE_LIST_DIRECTORY, 0, null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null_mut()) };
        assert_ne!(h, INVALID_HANDLE_VALUE, "all parent and observation readers must have settled");
        OwnedHandle(h).close().unwrap();
    }
    assert_eq!(fs::read(f.source.join("entry")).unwrap(), b"original"); assert!(!f.target.join("entry").exists());
}
#[test]
fn rejects_unqualified_reparse_tag_on_an_actual_ntfs_entry() {
    let f = Fixture::new(); fs::remove_file(f.source.join("entry")).unwrap(); fs::create_dir(f.source.join("entry")).unwrap();
    let h = handle(&f.source.join("entry"), GENERIC_WRITE_FOR_TEST);
    // Third-party GUID reparse point: valid storage, not a qualified link/junction.
    let mut buffer = [0u8; 24]; buffer[..4].copy_from_slice(&0x00000042u32.to_le_bytes()); buffer[8..24].fill(0x42);
    let mut written = 0;
    assert_ne!(unsafe { DeviceIoControl(h.0, FSCTL_SET_REPARSE_POINT, buffer.as_ptr().cast(), buffer.len() as u32, null_mut(), 0, &mut written, null_mut()) }, 0, "set unknown reparse: {}", unsafe { GetLastError() });
    h.close().unwrap();
    let mut owner = f.retain("symlink"); assert_eq!(owner.admission.error_code.as_deref(), Some("ENOTSUP")); assert!(owner.close().is_empty());
    assert!(!f.target.join("entry").exists()); assert!(fs::symlink_metadata(f.source.join("entry")).is_ok());
}
const GENERIC_WRITE_FOR_TEST: u32 = 0x40000000;
#[test]
fn rejects_network_device_alias_and_unknown_original_identities_without_ownership() {
    for path in [r"\\server\share", r"\\?\C:\staging", r"C:staging", r"C:\stage\..\next"] { assert!(path_parts(path).is_err()); }
    let f = Fixture::new(); let (td, ti) = facts(&f.target); let (sd, si) = facts(&f.source);
    let mut owner = retain_windows_entry_publication(spelling(&f.source), "entry".into(), sd.into(), si.into(), spelling(&f.target), "entry".into(), td.into(), ti.into(), sd.into(), 0u64.into(), "file".into());
    assert_ne!(owner.admission.outcome, "retained"); assert_eq!(owner.publish().outcome, "not-published"); assert!(owner.close().is_empty());
    assert_eq!(fs::read(f.source.join("entry")).unwrap(), b"original");
}


// Thread-local impersonation keeps privilege changes out of other test threads.
// Closing this duplicate token and reverting restores the original process token.
fn with_link_privilege<T>(action: impl FnOnce() -> T) -> T {
    use windows_sys::Win32::{Foundation::ERROR_NO_TOKEN, Security::*, System::Threading::{GetCurrentThread, OpenThreadToken}};
    struct Impersonation;
    impl Drop for Impersonation { fn drop(&mut self) { assert_ne!(unsafe { RevertToSelf() }, 0, "restore test thread identity"); } }
    let mut prior = null_mut();
    let existing = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut prior) };
    if existing != 0 { OwnedHandle(prior).close().unwrap(); panic!("fixture must not replace a preexisting impersonation token"); }
    assert_eq!(unsafe { GetLastError() }, ERROR_NO_TOKEN);
    assert_ne!(unsafe { ImpersonateSelf(SecurityImpersonation) }, 0);
    let guard = Impersonation;
    let mut raw = null_mut();
    assert_ne!(unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, 1, &mut raw) }, 0);
    let token = OwnedHandle(raw);
    let name: Vec<u16> = "SeCreateSymbolicLinkPrivilege".encode_utf16().chain(Some(0)).collect();
    let mut luid = unsafe { zeroed() };
    assert_ne!(unsafe { LookupPrivilegeValueW(null(), name.as_ptr(), &mut luid) }, 0);
    let privileges = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }] };
    assert_ne!(unsafe { AdjustTokenPrivileges(token.0, 0, &privileges, 0, null_mut(), null_mut()) }, 0);
    assert_eq!(unsafe { GetLastError() }, 0, "symbolic-link privilege must actually be assigned");
    let result = action(); token.close().unwrap(); drop(guard); result
}

fn install_reparse(path: &Path, tag: u32, substitute: &[u16], print: &[u16], relative: bool) -> Vec<u8> {
    let prefix = if tag == 0xa000000c { 12 } else { 8 };
    let data_length = prefix + (substitute.len() + print.len() + 2) * 2;
    let mut bytes = vec![0u8; 8 + data_length];
    bytes[..4].copy_from_slice(&tag.to_le_bytes()); bytes[4..6].copy_from_slice(&(data_length as u16).to_le_bytes());
    bytes[10..12].copy_from_slice(&((substitute.len() * 2) as u16).to_le_bytes());
    bytes[12..14].copy_from_slice(&(((substitute.len() + 1) * 2) as u16).to_le_bytes());
    bytes[14..16].copy_from_slice(&((print.len() * 2) as u16).to_le_bytes());
    if tag == 0xa000000c { bytes[16..20].copy_from_slice(&(u32::from(relative)).to_le_bytes()); }
    let mut cursor = 8 + prefix;
    for word in substitute.iter().copied().chain(Some(0)).chain(print.iter().copied()).chain(Some(0)) {
        bytes[cursor..cursor+2].copy_from_slice(&word.to_le_bytes()); cursor += 2;
    }
    let h = handle(path, GENERIC_WRITE_FOR_TEST); let mut written = 0;
    let (ok, error) = with_link_privilege(|| {
        let ok = unsafe { DeviceIoControl(h.0, FSCTL_SET_REPARSE_POINT, bytes.as_ptr().cast(), bytes.len() as u32, null_mut(), 0, &mut written, null_mut()) };
        (ok, unsafe { GetLastError() })
    });
    assert_ne!(ok, 0, "set qualified reparse: {error}");
    let stored = reparse_bytes(h.0).unwrap(); h.close().unwrap(); assert_eq!(stored, bytes); stored
}
#[test]
fn all_link_kinds_preserve_the_complete_opaque_reparse_buffer() {
    for (tag, directory, relative) in [(0xa000000c, false, true), (0xa000000c, false, false),
        (0xa000000c, true, true), (0xa000000c, true, false), (0xa0000003, true, false)] {
        let f = Fixture::new(); let source = f.source.join("entry"); fs::remove_file(&source).unwrap();
        if directory { fs::create_dir(&source).unwrap(); } else { fs::write(&source, b"").unwrap(); }
        let payload = f.root.join("payload"); fs::create_dir(&payload).unwrap(); fs::write(payload.join("bytes"), b"external").unwrap();
        let substitute = if relative { r"..\payload".into() } else { format!(r"\??\{}", spelling(&payload)) };
        let bytes = install_reparse(&source, tag, &substitute.encode_utf16().collect::<Vec<_>>(), &"opaque-print-字".encode_utf16().collect::<Vec<_>>(), relative);
        let original = facts(&source); let mut owner = f.retain("symlink"); admitted(&owner);
        assert_eq!(owner.publish().outcome, "committed"); owner.owner.as_mut().unwrap().current(true).unwrap();
        assert_eq!(facts(&f.target.join("entry")), original);
        let h = handle(&f.target.join("entry"), FILE_READ_ATTRIBUTES); assert_eq!(reparse_bytes(h.0).unwrap(), bytes); h.close().unwrap();
        assert!(owner.close().is_empty()); assert!(fs::symlink_metadata(&source).is_err());
        assert_eq!(fs::read(payload.join("bytes")).unwrap(), b"external");
    }
}
#[test]
fn in_place_reparse_target_change_is_observed_before_dispatch() {
    let f = Fixture::new(); let source = f.source.join("entry"); fs::write(&source, b"").unwrap();
    install_reparse(&source, 0xa000000c, &"first-missing".encode_utf16().collect::<Vec<_>>(), &"first-missing".encode_utf16().collect::<Vec<_>>(), true);
    let original = facts(&source); let mut owner = f.retain("symlink"); admitted(&owner);
    let newer = install_reparse(&source, 0xa000000c, &"second-missing".encode_utf16().collect::<Vec<_>>(), &"second-missing".encode_utf16().collect::<Vec<_>>(), true);
    assert_eq!(facts(&source), original); let result = owner.publish(); assert_eq!(result.outcome, "not-published");
    assert_eq!(result.error_code.as_deref(), Some("path-mismatch")); assert!(owner.close().is_empty());
    let h = handle(&source, FILE_READ_ATTRIBUTES); assert_eq!(reparse_bytes(h.0).unwrap(), newer); h.close().unwrap();
    assert!(!f.target.join("entry").exists());
}
