use std::sync::atomic::{AtomicBool, Ordering};

use crate::unix::{borrowed, os_error, validate_child_basename};
use crate::{NativeResult, native_error};

pub fn probe(parent_fd: i32) -> NativeResult<Option<String>> {
    let stats = rustix::fs::fstatfs(borrowed(parent_fd))
        .map_err(|error| os_error(error, "inspect clone filesystem"))?;
    #[cfg(target_os = "linux")]
    let supported = match stats.f_type as u64 {
        0x9123_683e => Some("btrfs"),
        0x5846_5342 => Some("xfs"),
        _ => None,
    };
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
            "CLONE_UNAVAILABLE",
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

#[cfg(target_os = "macos")]
fn restore_apfs_directory_timestamps(
    source_fd: i32,
    parent_fd: i32,
    name: &std::ffi::CStr,
    source_root: &rustix::fs::Stat,
    cancelled: &AtomicBool,
) -> NativeResult<()> {
    use crate::unix::open_cleanup_directory;
    use rustix::fs::{AtFlags, Dir, FileType, Stat, Timespec, Timestamps};
    use std::os::fd::{AsRawFd, OwnedFd};

    struct Directory {
        entries: Dir,
        target: OwnedFd,
        times: Timestamps,
    }

    fn directory(source: OwnedFd, target: OwnedFd, metadata: &Stat) -> NativeResult<Directory> {
        let times = Timestamps {
            last_access: Timespec {
                tv_sec: metadata.st_atime,
                tv_nsec: metadata.st_atime_nsec,
            },
            last_modification: Timespec {
                tv_sec: metadata.st_mtime,
                tv_nsec: metadata.st_mtime_nsec,
            },
        };
        // This stream owns the freshly opened source fd. Capture timestamps
        // before reading it, since readdir can update source access time.
        let entries = Dir::new(source)
            .map_err(|error| os_error(error, "open APFS clone directory stream"))?;
        Ok(Directory {
            entries,
            target,
            times,
        })
    }

    check_cancelled(cancelled)?;
    let source = open_cleanup_directory(source_fd, c".")?;
    let target = open_cleanup_directory(parent_fd, name)?;
    let mut stack = vec![directory(source, target, source_root)?];
    // APFS resets timestamps on nested directories as well as the clone root.
    // Repair directories bottom-up; regular file data and metadata remain the
    // bulk clone's responsibility. The stack retains only active ancestors.
    while let Some(parent) = stack.last_mut() {
        check_cancelled(cancelled)?;
        if let Some(entry) = parent.entries.next() {
            let entry =
                entry.map_err(|error| os_error(error, "read APFS clone directory entry"))?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let source_parent = parent
                .entries
                .fd()
                .map_err(|error| os_error(error, "inspect APFS source directory stream"))?;
            let kind = if entry.file_type() == FileType::Unknown {
                let metadata =
                    rustix::fs::statat(source_parent, name, AtFlags::SYMLINK_NOFOLLOW)
                        .map_err(|error| os_error(error, "classify APFS clone directory entry"))?;
                FileType::from_raw_mode(metadata.st_mode)
            } else {
                entry.file_type()
            };
            if !kind.is_dir() {
                continue;
            }
            let source = open_cleanup_directory(source_parent.as_raw_fd(), name)?;
            let metadata = rustix::fs::fstat(&source)
                .map_err(|error| os_error(error, "inspect APFS clone source directory"))?;
            if metadata.st_ino != entry.ino() {
                return Err(native_error(
                    "path-mismatch",
                    "APFS source directory changed after enumeration",
                ));
            }
            let target = open_cleanup_directory(parent.target.as_raw_fd(), name)?;
            stack.push(directory(source, target, &metadata)?);
        } else {
            let completed = stack.pop().unwrap();
            rustix::fs::futimens(&completed.target, &completed.times)
                .map_err(|error| os_error(error, "preserve APFS clone directory timestamps"))?;
        }
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
        if probe(parent_fd)?.as_deref() == Some("xfs") {
            return rustix::fs::mkdirat(
                borrowed(parent_fd),
                basename,
                rustix::fs::Mode::from_bits_retain(0o700),
            )
            .map_err(|error| os_error(error, "create XFS clone source directory"));
        }
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
        if probe(parent_fd)?.as_deref() == Some("xfs") {
            return crate::clone_linux::clone_tree(
                source_fd,
                parent_fd,
                basename,
                cancelled,
                _concurrency,
            );
        }
        // Btrfs assigns inode 256 to subvolume roots. Snapshotting an ordinary
        // directory must fail rather than silently changing the operation.
        if source.st_ino != 256 {
            return Err(native_error(
                "CLONE_UNAVAILABLE",
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
        // docs/copy.md for Apple's directory-clone warning and XNU references.
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
            return Err(
                if error == rustix::io::Errno::NOTSUP || error == rustix::io::Errno::OPNOTSUPP {
                    native_error(
                        "CLONE_UNAVAILABLE",
                        format!("clone APFS directory: {error}"),
                    )
                } else {
                    os_error(error, "clone APFS directory")
                },
            );
        }
        restore_apfs_directory_timestamps(
            source_fd,
            parent_fd,
            name.as_c_str(),
            &source,
            cancelled,
        )?;
    }
    // These bulk operations cannot be interrupted once dispatched. Report
    // cancellation only after their writes settle; recovery may then proceed.
    check_cancelled(cancelled)
}
