use std::ffi::CString;
use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

unsafe extern "C" {
    fn acl_from_text(text: *const libc::c_char) -> *mut c_void;
}

struct Fixture(PathBuf);

impl Fixture {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fs-safe-darwin-acl-{label}-{}-{nonce}", std::process::id(),
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let directory = File::open(&path).unwrap();
        clear_private_clone_acl(directory.as_fd()).unwrap();
        require_receipt_no_acl(&inspect_security(directory.as_fd()).unwrap(), "test fixture")
            .unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn entry_acl() -> OwnedAcl {
    // A non-inheriting metadata-only ACE exercises presence without granting
    // access to file contents or directory traversal to another principal.
    let text = CString::new("!#acl 1\nuser:00000000-0000-0000-0000-000000000001:::allow:readattr\n").unwrap();
    // SAFETY: text is NUL-terminated; a successful result is a new ACL allocation.
    let raw = unsafe { acl_from_text(text.as_ptr()) };
    OwnedAcl(NonNull::new(raw).expect("test ACL must parse"))
}

fn set_entry_acl(fd: BorrowedFd<'_>) {
    let acl = entry_acl();
    // SAFETY: the descriptor and owned ACL remain live for this call.
    assert_eq!(unsafe { acl_set_fd_np(fd.as_raw_fd(), acl.0.as_ptr(), ACL_TYPE_EXTENDED) }, 0);
    assert_eq!(inspect_acl(fd).unwrap(), AclState::Present);
}

#[test]
fn darwin_zero_success_means_present_even_with_stale_errno() {
    assert_eq!(first_entry_state(0, std::io::Error::from_raw_os_error(libc::EINVAL), true).unwrap(), AclState::Present);
    assert_eq!(inspect_owned_acl(&entry_acl()).unwrap(), AclState::Present);
}

#[test]
fn first_entry_of_valid_empty_acl_uses_darwin_end_of_list() {
    // SAFETY: acl_init returns a new allocation owned by this test.
    let acl = OwnedAcl(NonNull::new(unsafe { acl_init(0) }).unwrap());
    assert_eq!(inspect_owned_acl(&acl).unwrap(), AclState::Empty);
    assert_eq!(first_entry_state(-1, std::io::Error::from_raw_os_error(libc::EINVAL), false).unwrap(), AclState::Empty);
}

#[test]
fn unexpected_entry_results_and_failures_are_not_empty_acls() {
    for (result, has_entry) in [(0, false), (1, true), (1, false), (-1, true)] {
        assert!(first_entry_state(result, std::io::Error::from_raw_os_error(libc::EINVAL), has_entry).is_err());
    }
    for errno in [libc::EIO, libc::EACCES, libc::ENOTSUP, 0] {
        assert!(first_entry_state(-1, std::io::Error::from_raw_os_error(errno), false).is_err());
    }
}

#[test]
fn incomplete_filesec_cannot_be_misclassified_as_an_absent_acl() {
    // This is the state Apple libc leaves behind when its fstatx_np ACL-buffer
    // realloc fails after an otherwise successful extended-stat syscall.
    // SAFETY: filesec_init returns either null or a fresh owned allocation.
    let filesec = OwnedFileSec(
        NonNull::new(unsafe { filesec_init() }).expect("test filesec must allocate"),
    );
    assert!(require_complete_filesec(&filesec).is_err());
    assert!(filesec_acl_state(&filesec).is_err());
}

#[test]
fn failure_uses_saved_errno_instead_of_later_cleanup_errno() {
    let saved = std::io::Error::from_raw_os_error(libc::EACCES);
    // SAFETY: __error returns the current thread's writable errno slot.
    unsafe { *libc::__error() = libc::EINVAL };
    let error = first_entry_state(-1, saved, false).unwrap_err();
    assert_eq!(error.status, "EACCES");
}

#[test]
fn inspection_and_acl_clear_keep_the_callers_descriptor_open() {
    let fixture = Fixture::new("borrowed");
    let file = File::create(fixture.0.join("file")).unwrap();
    set_entry_acl(file.as_fd());
    assert_eq!(inspect_descriptor(file.as_raw_fd()).unwrap(), AclState::Present);
    file.metadata().unwrap();
    clear_private_clone_acl(file.as_fd()).unwrap();
    require_receipt_no_acl(&inspect_security(file.as_fd()).unwrap(), "test ACL clear").unwrap();
    assert!(matches!(inspect_descriptor(file.as_raw_fd()).unwrap(), AclState::Absent | AclState::Empty));
    file.metadata().unwrap();
    assert_eq!(inspect_descriptor(-1).unwrap_err().status, "EBADF");
    file.metadata().unwrap();
}

#[test]
fn fused_security_observation_binds_exact_metadata_and_acl_to_one_descriptor() {
    let fixture = Fixture::new("fused");
    let path = fixture.0.join("file");
    let file = File::create(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

    let plain = inspect_security(file.as_fd()).unwrap();
    let stat = rustix::fs::fstat(file.as_fd()).unwrap();
    assert!(plain.matches_identity(&stat));
    assert!(plain.is_file());
    assert_eq!(plain.mode, stat.st_mode);
    assert_eq!(plain.uid, stat.st_uid as u32);
    assert_eq!(plain.gid, stat.st_gid as u32);
    assert_eq!(plain.flags, stat.st_flags);
    assert!(matches!(plain.acl, AclState::Absent | AclState::Empty));

    set_entry_acl(file.as_fd());
    let with_acl = inspect_security(file.as_fd()).unwrap();
    assert!(with_acl.matches_identity(&stat));
    assert_eq!(with_acl.acl, AclState::Present);
    assert_ne!(plain, with_acl);

    clear_private_clone_acl(file.as_fd()).unwrap();
    let cleared = inspect_security(file.as_fd()).unwrap();
    assert!(matches!(cleared.acl, AclState::Absent | AclState::Empty));
    assert_eq!(cleared.device, plain.device);
    assert_eq!(cleared.inode, plain.inode);
}

#[test]
fn security_receipts_detect_mode_changes_without_losing_identity() {
    let fixture = Fixture::new("receipt-mode");
    let path = fixture.0.join("file");
    let file = File::create(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let before = inspect_security(file.as_fd()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let after = inspect_security(file.as_fd()).unwrap();
    assert_eq!((before.device, before.inode), (after.device, after.inode));
    assert_ne!(before, after);
    assert_eq!(after.mode & 0o7777, 0o400);
}

#[test]
fn owned_duplicate_survives_original_close_and_path_replacement() {
    let fixture = Fixture::new("retained");
    let path = fixture.0.join("file");
    let file = File::create(&path).unwrap();
    set_entry_acl(file.as_fd());
    let retained = retain_descriptor(file.as_raw_fd()).unwrap();
    drop(file);
    fs::rename(&path, fixture.0.join("moved")).unwrap();
    let replacement = File::create(&path).unwrap();
    clear_private_clone_acl(replacement.as_fd()).unwrap();
    require_receipt_no_acl(
        &inspect_security(replacement.as_fd()).unwrap(),
        "test replacement ACL clear",
    )
    .unwrap();
    assert_eq!(inspect_acl(retained.as_fd()).unwrap(), AclState::Present);
    assert!(matches!(inspect_acl(replacement.as_fd()).unwrap(), AclState::Absent | AclState::Empty));
}

#[test]
fn clone_rejects_parent_acl_before_creating_a_stage_or_copying_bytes() {
    let fixture = Fixture::new("clone-parent");
    let source_path = fixture.0.join("source");
    fs::write(&source_path, b"fixture contents").unwrap();
    let source = File::open(&source_path).unwrap();
    let parent_path = fixture.0.join("parent");
    fs::create_dir(&parent_path).unwrap();
    fs::set_permissions(&parent_path, fs::Permissions::from_mode(0o700)).unwrap();
    let parent = File::open(&parent_path).unwrap();
    set_entry_acl(parent.as_fd());
    let error = crate::unix::clone_file_exclusive(source.as_raw_fd(), parent.as_raw_fd(), "copy").unwrap_err();
    assert_eq!(error.status, "ENOTSUP");
    assert_eq!(fs::read_dir(&parent_path).unwrap().count(), 0);
    assert_eq!(fs::read(&source_path).unwrap(), b"fixture contents");
    assert_eq!(inspect_acl(parent.as_fd()).unwrap(), AclState::Present);
}

#[test]
fn clone_strips_payload_acl_before_returning_its_descriptor() {
    let fixture = Fixture::new("clone-payload");
    let source_path = fixture.0.join("source");
    fs::write(&source_path, b"fixture contents").unwrap();
    let source = File::open(&source_path).unwrap();
    set_entry_acl(source.as_fd());
    let parent = File::open(&fixture.0).unwrap();
    let fd = match crate::unix::clone_file_exclusive(source.as_raw_fd(), parent.as_raw_fd(), "copy") {
        Ok(fd) => fd,
        Err(error) if error.status == "ENOTSUP" && error.reason.starts_with("fclonefileat:") => return,
        Err(error) => panic!("clone admission or normalization failed: {error:?}"),
    };
    // SAFETY: clone returned a newly owned descriptor.
    let cloned = unsafe { OwnedFd::from_raw_fd(fd) };
    assert!(matches!(inspect_acl(cloned.as_fd()).unwrap(), AclState::Absent | AclState::Empty));
    assert_eq!(inspect_acl(source.as_fd()).unwrap(), AclState::Present);
    assert_eq!(fs::read(fixture.0.join("copy")).unwrap(), b"fixture contents");
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
}
