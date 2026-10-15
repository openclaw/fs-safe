use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};

use rustix::fs::{FileType, IFlags};
use rustix::io::Errno;

use crate::unix::{file_matches_child, os_error, terminal_clone_error};
use crate::{NativeResult, native_error};

fn preparation_error(error: Errno, operation: &str, flags_ioctl: bool) -> crate::NativeError {
    // These refusals mean clone preparation is unavailable, not that copying
    // is unsafe. Unlike FICLONE, preparation I/O errors never permit fallback.
    let unavailable = matches!(error, Errno::PERM | Errno::ACCESS | Errno::NOSYS)
        || error == Errno::NOTSUP
        || error == Errno::OPNOTSUPP
        || (flags_ioctl && matches!(error, Errno::NOTTY | Errno::INVAL));
    if unavailable {
        native_error("ENOTSUP", format!("{operation} is unavailable: {error}"))
    } else {
        terminal_clone_error(os_error(error, operation))
    }
}

fn require_empty_target(target: &OwnedFd, parent_fd: i32, name: &str) -> NativeResult<()> {
    let stat = rustix::fs::fstat(target).map_err(|error| {
        terminal_clone_error(os_error(error, "inspect clone preparation target"))
    })?;
    if !FileType::from_raw_mode(stat.st_mode).is_file()
        || stat.st_size != 0
        || stat.st_nlink != 1
        || !file_matches_child(parent_fd, name, target.as_raw_fd()).map_err(terminal_clone_error)?
    {
        return Err(native_error("EIO", "clone preparation target changed"));
    }
    Ok(())
}

pub(crate) fn prepare_nocow(
    source: BorrowedFd<'_>,
    target: &OwnedFd,
    parent_fd: i32,
    name: &str,
) -> NativeResult<()> {
    for fd in [source.as_raw_fd(), target.as_raw_fd()] {
        let stat = rustix::fs::fstatfs(crate::unix::borrowed(fd))
            .map_err(|error| preparation_error(error, "inspect clone filesystem", false))?;
        if stat.f_type as u64 != 0x9123_683e {
            return Ok(());
        }
    }
    require_empty_target(target, parent_fd, name)?;
    let source_flags = rustix::fs::ioctl_getflags(source)
        .map_err(|error| preparation_error(error, "read clone source flags", true))?;
    let target_flags = rustix::fs::ioctl_getflags(target)
        .map_err(|error| preparation_error(error, "read clone target flags", true))?;
    let mut desired = target_flags;
    desired.set(IFlags::NOCOW, source_flags.contains(IFlags::NOCOW));
    if desired != target_flags {
        // Only the newly exclusive, empty target may change policy. Keep its
        // other flags, including compression; incompatible policy must refuse.
        rustix::fs::ioctl_setflags(target, desired)
            .map_err(|error| preparation_error(error, "set clone target NOCOW", true))?;
        let observed = rustix::fs::ioctl_getflags(target)
            .map_err(|error| terminal_clone_error(os_error(error, "verify clone target flags")))?;
        if observed != desired {
            return Err(native_error(
                "EIO",
                "clone target flags did not match requested policy",
            ));
        }
    }
    // NOCOW is only a prerequisite: hidden NODATASUM state and concurrent
    // source policy changes still belong to the authoritative FICLONE check.
    require_empty_target(target, parent_fd, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_io_errors_are_not_clone_capability_refusals() {
        for ioctl in [false, true] {
            for errno in [Errno::IO, Errno::AGAIN, Errno::BADF] {
                let error = preparation_error(errno, "prepare clone", ioctl);
                assert_ne!(error.status, "ENOTSUP");
            }
            for errno in [Errno::PERM, Errno::ACCESS, Errno::NOSYS, Errno::NOTSUP] {
                assert_eq!(
                    preparation_error(errno, "prepare clone", ioctl).status,
                    "ENOTSUP"
                );
            }
        }
        assert_eq!(
            preparation_error(Errno::INVAL, "get flags", true).status,
            "ENOTSUP"
        );
        assert_eq!(
            preparation_error(Errno::INVAL, "statfs", false).status,
            "EIO"
        );
    }

    #[test]
    fn target_admission_rejects_growth_hardlinks_and_replaced_names() {
        use crate::unix::create_exclusive_target;
        use std::fs::{self, File};

        let path = crate::test_support::temp_path("clone-policy-admission");
        fs::create_dir(&path).unwrap();
        let parent = File::open(&path).unwrap();
        let target = create_exclusive_target(parent.as_raw_fd(), "stage").unwrap();
        require_empty_target(&target, parent.as_raw_fd(), "stage").unwrap();
        rustix::io::pwrite(&target, b"x", 0).unwrap();
        assert_eq!(
            require_empty_target(&target, parent.as_raw_fd(), "stage")
                .unwrap_err()
                .status,
            "EIO"
        );
        rustix::fs::ftruncate(&target, 0).unwrap();
        fs::hard_link(path.join("stage"), path.join("alias")).unwrap();
        assert_eq!(
            require_empty_target(&target, parent.as_raw_fd(), "stage")
                .unwrap_err()
                .status,
            "EIO"
        );
        fs::remove_file(path.join("alias")).unwrap();
        fs::rename(path.join("stage"), path.join("owned")).unwrap();
        fs::write(path.join("stage"), b"replacement").unwrap();
        assert_eq!(
            require_empty_target(&target, parent.as_raw_fd(), "stage")
                .unwrap_err()
                .status,
            "EIO"
        );
        assert_eq!(fs::read(path.join("stage")).unwrap(), b"replacement");
        fs::remove_dir_all(path).unwrap();
    }
}
