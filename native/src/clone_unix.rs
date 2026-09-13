use std::sync::atomic::{AtomicBool, Ordering};

use crate::unix::{borrowed, os_error, validate_child_basename};
use crate::{NativeResult, native_error};

pub fn probe(parent_fd: i32) -> NativeResult<Option<String>> {
    let stats = rustix::fs::fstatfs(borrowed(parent_fd))
        .map_err(|error| os_error(error, "inspect clone filesystem"))?;
    #[cfg(target_os = "linux")]
    let supported = (stats.f_type as u64 == 0x9123_683e).then_some("btrfs");
    #[cfg(target_os = "macos")]
    let supported = stats.f_fstypename[..5]
        .iter()
        .map(|&value| value as u8)
        .eq(b"apfs\0".iter().copied())
        .then_some("apfs");
    Ok(supported.map(str::to_owned))
}

fn require_supported(parent_fd: i32) -> NativeResult<()> {
    if probe(parent_fd)?.is_none() {
        return Err(native_error(
            "ENOTSUP",
            "directory cloning is unavailable on this filesystem",
        ));
    }
    Ok(())
}

fn check_cancelled(cancelled: &AtomicBool) -> NativeResult<()> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(native_error("Cancelled", "directory cloning aborted"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct BtrfsVolumeArgs {
    fd: i64,
    name: [u8; 4088],
}

#[cfg(target_os = "linux")]
const _: () = assert!(std::mem::size_of::<BtrfsVolumeArgs>() == 4096);

#[cfg(target_os = "linux")]
fn btrfs_mutation<const OPCODE: rustix::ioctl::Opcode>(
    parent_fd: i32,
    basename: &str,
    source_fd: i32,
) -> NativeResult<()> {
    validate_child_basename(basename)?;
    let mut args = BtrfsVolumeArgs {
        fd: i64::from(source_fd),
        name: [0; 4088],
    };
    if basename.len() >= args.name.len() {
        return Err(native_error(
            "ENAMETOOLONG",
            "clone destination basename is too long",
        ));
    }
    args.name[..basename.len()].copy_from_slice(basename.as_bytes());
    // Linux uapi/linux/btrfs.h: SNAP_CREATE and SUBVOL_CREATE take the same
    // 4096-byte btrfs_ioctl_vol_args. The kernel creates one exclusive child.
    unsafe {
        rustix::ioctl::ioctl(
            borrowed(parent_fd),
            rustix::ioctl::Setter::<OPCODE, BtrfsVolumeArgs>::new(args),
        )
    }
    .map_err(|error| os_error(error, "create Btrfs clone directory"))
}

pub fn create_source(parent_fd: i32, basename: &str) -> NativeResult<()> {
    validate_child_basename(basename)?;
    require_supported(parent_fd)?;
    #[cfg(target_os = "linux")]
    {
        const CREATE: rustix::ioctl::Opcode =
            rustix::ioctl::opcode::write::<BtrfsVolumeArgs>(0x94, 14);
        btrfs_mutation::<CREATE>(parent_fd, basename, 0)
    }
    #[cfg(target_os = "macos")]
    {
        rustix::fs::mkdirat(
            borrowed(parent_fd),
            basename,
            rustix::fs::Mode::from_bits_retain(0o700),
        )
        .map_err(|error| os_error(error, "create clone source directory"))
    }
}

pub fn clone_tree(
    source_fd: i32,
    parent_fd: i32,
    basename: &str,
    cancelled: &AtomicBool,
    _concurrency: usize,
) -> NativeResult<()> {
    validate_child_basename(basename)?;
    check_cancelled(cancelled)?;
    require_supported(parent_fd)?;
    require_supported(source_fd)?;
    let source = rustix::fs::fstat(borrowed(source_fd))
        .map_err(|error| os_error(error, "inspect clone source"))?;
    if !rustix::fs::FileType::from_raw_mode(source.st_mode).is_dir() {
        return Err(native_error("ENOTDIR", "clone source must be a directory"));
    }
    #[cfg(target_os = "linux")]
    {
        // Btrfs assigns inode 256 to subvolume roots. Snapshotting an ordinary
        // directory must fail rather than silently changing the operation.
        if source.st_ino != 256 {
            return Err(native_error(
                "ENOTSUP",
                "Btrfs directory cloning requires a subvolume source",
            ));
        }
        const SNAPSHOT: rustix::ioctl::Opcode =
            rustix::ioctl::opcode::write::<BtrfsVolumeArgs>(0x94, 1);
        check_cancelled(cancelled)?;
        btrfs_mutation::<SNAPSHOT>(parent_fd, basename, source_fd)?;
    }
    #[cfg(target_os = "macos")]
    {
        let name = std::ffi::CString::new(basename)
            .map_err(|_| native_error("EINVAL", "clone destination contains a NUL byte"))?;
        // CLONE_ACL can copy the root ACL, but directory clones can lose both
        // source and inherited descendant ACLs. Callers own eligibility; see
        // docs/clone.md for Apple's directory-clone warning and XNU references.
        // Both descriptors stay pinned until this bulk operation settles.
        const CLONE_NOFOLLOW: u32 = 0x0001;
        const CLONE_ACL: u32 = 0x0004;
        check_cancelled(cancelled)?;
        if unsafe {
            libc::fclonefileat(
                source_fd,
                parent_fd,
                name.as_ptr(),
                CLONE_NOFOLLOW | CLONE_ACL,
            )
        } != 0
        {
            let error = rustix::io::Errno::from_raw_os_error(
                std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or(libc::EIO),
            );
            return Err(os_error(error, "clone APFS directory"));
        }
    }
    // These bulk operations cannot be interrupted once dispatched. Report
    // cancellation only after their writes settle; recovery may then proceed.
    check_cancelled(cancelled)
}
