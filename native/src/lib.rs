#![deny(unsafe_op_in_unsafe_fn)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod archive;
mod archive_gzip;
mod fast_file;
mod clone_tree;
mod clone_metadata;
#[cfg(target_os = "linux")]
mod clone_linux;
#[cfg(unix)]
mod clone_unix;
#[cfg(windows)]
mod clone_windows;
#[cfg(windows)]
mod copy_windows;
#[cfg(target_os = "linux")]
mod copy_linux;
#[cfg(unix)]
mod file_copy;
mod owned_tree;
#[cfg(unix)]
mod realpath;
#[cfg(unix)]
mod staged_file;
use fs_safe_archive_core::tar_meter;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
mod windows_security;
mod windows_secure_file;

#[napi(object)]
pub struct FileIdentity {
    pub dev: f64,
    pub ino: f64,
    pub mode: u32,
    pub nlink: f64,
    pub size: f64,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
}

#[napi(object)]
pub struct OpenBeneathResult {
    pub fd: i32,
    pub containment: String,
}

pub(crate) type NativeResult<T> = std::result::Result<T, Error<String>>;

pub(crate) fn native_error(code: impl Into<String>, message: impl Into<String>) -> Error<String> {
    Error::new(code.into(), message.into())
}

fn invalid_path(message: impl Into<String>) -> Error<String> {
    native_error("EINVAL", message)
}

#[inline]
fn is_windows_path_separator(byte: u8) -> bool {
    byte == b'\\' || byte == b'/'
}

#[inline]
fn is_ascii_drive_letter(byte: u8) -> bool {
    byte.is_ascii_alphabetic()
}

fn windows_filesystem_path_has_forbidden_colon(path: &str) -> bool {
    let bytes = path.as_bytes();
    // A rooted ASCII drive designator is the only colon-bearing Windows
    // filesystem syntax that is not an alternate stream or namespace alias.
    // Keep device-path policy separate: recognizing \\.\C:\ here does not
    // authorize device paths at any call site that already rejects them.
    let allowed_drive_colon = if bytes.len() >= 3
        && is_ascii_drive_letter(bytes[0])
        && bytes[1] == b':'
        && is_windows_path_separator(bytes[2])
    {
        Some(1)
    } else if bytes.len() >= 7
        && is_windows_path_separator(bytes[0])
        && is_windows_path_separator(bytes[1])
        && (bytes[2] == b'?' || bytes[2] == b'.')
        && is_windows_path_separator(bytes[3])
        && is_ascii_drive_letter(bytes[4])
        && bytes[5] == b':'
        && is_windows_path_separator(bytes[6])
    {
        Some(5)
    } else {
        None
    };

    bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b':' && Some(index) != allowed_drive_colon)
}

pub(crate) fn validate_windows_filesystem_path(path: &str) -> NativeResult<()> {
    if cfg!(windows) && windows_filesystem_path_has_forbidden_colon(path) {
        return Err(invalid_path(
            "Windows filesystem path contains alternate stream syntax",
        ));
    }
    Ok(())
}

fn validate_relative_path_with_separators(
    path: &str,
    allow_root: bool,
    backslash_is_separator: bool,
) -> NativeResult<()> {
    if path.as_bytes().contains(&0) {
        return Err(invalid_path("relative path contains a NUL byte"));
    }
    if cfg!(windows) && path.as_bytes().contains(&b':') {
        return Err(invalid_path(
            "relative path contains Windows alternate stream syntax",
        ));
    }
    if path.is_empty() || path == "." {
        return if allow_root {
            Ok(())
        } else {
            Err(invalid_path("operation requires a non-root path"))
        };
    }
    if path.starts_with('/') || (backslash_is_separator && path.starts_with('\\')) {
        return Err(invalid_path(
            "path must be relative to the supplied root descriptor",
        ));
    }
    let escapes = if backslash_is_separator {
        path.split(['/', '\\']).any(|segment| segment == "..")
    } else {
        path.split('/').any(|segment| segment == "..")
    };
    if escapes {
        return Err(invalid_path("relative path must not contain '..'"));
    }
    Ok(())
}

fn validate_relative_path(path: &str, allow_root: bool) -> NativeResult<()> {
    validate_relative_path_with_separators(path, allow_root, cfg!(windows))
}

pub(crate) fn validate_portable_relative_path(path: &str, allow_root: bool) -> NativeResult<()> {
    validate_relative_path_with_separators(path, allow_root, true)
}

pub(crate) fn into_napi<T>(env: Env, result: NativeResult<T>) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let reason = error.reason;
            env.throw_error(&reason, Some(error.status.as_ref()))?;
            Err(Error::new(Status::PendingException, reason))
        }
    }
}

#[napi(js_name = "openBeneath")]
pub fn open_beneath(
    env: Env,
    root_fd: i32,
    rel_path: String,
    flags: i32,
) -> Result<OpenBeneathResult> {
    let result = validate_relative_path(&rel_path, true)
        .and_then(|()| platform::open_beneath(root_fd, &rel_path, flags))
        .map(|fd| OpenBeneathResult {
            fd,
            containment: if cfg!(target_os = "linux") {
                "kernel-atomic".to_owned()
            } else {
                "best-effort".to_owned()
            },
        });
    into_napi(env, result)
}

#[napi(js_name = "mkdirBeneath")]
pub fn mkdir_beneath(env: Env, root_fd: i32, rel_path: String, mode: u32) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&rel_path, true)
            .and_then(|()| platform::mkdir_beneath(root_fd, &rel_path, mode)),
    )
}

#[napi(js_name = "linkBeneath")]
pub fn link_beneath(
    env: Env,
    source_root_fd: i32,
    source_rel_path: String,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&source_rel_path, false)
            .and_then(|()| validate_relative_path(&target_rel_path, false))
            .and_then(|()| {
                platform::link_beneath(
                    source_root_fd,
                    &source_rel_path,
                    target_root_fd,
                    &target_rel_path,
                )
            }),
    )
}

#[napi(js_name = "renameNoReplace")]
pub fn rename_no_replace(
    env: Env,
    source_root_fd: i32,
    source_rel_path: String,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&source_rel_path, false)
            .and_then(|()| validate_relative_path(&target_rel_path, false))
            .and_then(|()| {
                platform::rename_no_replace(
                    source_root_fd,
                    &source_rel_path,
                    target_root_fd,
                    &target_rel_path,
                )
            }),
    )
}

#[napi(js_name = "renameReplace")]
pub fn rename_replace(
    env: Env,
    source_root_fd: i32,
    source_rel_path: String,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&source_rel_path, false)
            .and_then(|()| validate_relative_path(&target_rel_path, false))
            .and_then(|()| {
                platform::rename_replace(
                    source_root_fd,
                    &source_rel_path,
                    target_root_fd,
                    &target_rel_path,
                )
            }),
    )
}

#[napi(js_name = "fstatIdentity")]
pub fn fstat_identity(env: Env, fd: i32) -> Result<FileIdentity> {
    into_napi(env, platform::fstat_identity(fd))
}

pub use archive::{
    NativeArchiveEntry, NativeArchivePlanEntry, extract_archive_native, inspect_archive_native,
    read_archive_entry_native,
};
pub use fast_file::{
    FileHash, NativeCopyResult, clone_file_exclusive, copy_file_range_exclusive, sha256_file,
};
#[cfg(windows)]
pub use copy_windows::copy_file_contents;
#[cfg(target_os = "linux")]
pub use copy_linux::copy_file_contents;
#[cfg(unix)]
pub use file_copy::{NativeFileCopyResult, copy_file_exclusive};
pub use owned_tree::{
    NativeOwnedTreeRemovalResult, owned_tree_removal_available, remove_owned_tree,
    remove_owned_tree_sync,
};
#[cfg(unix)]
pub use staged_file::{create_staged_file, remove_staged_file, staged_file_matches};
pub use windows_security::{
    WindowsAccessControlEntry, WindowsAceFlags, WindowsSecurityFacts, create_private_directory,
    read_owner_and_dacl,
};
pub use windows_secure_file::{
    WindowsDescriptorSecurityFacts, inspect_windows_secure_file_handle,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filesystem_paths_follow_host_separator_rules() {
        assert!(validate_relative_path("../escape", false).is_err());
        if cfg!(windows) {
            assert!(validate_relative_path("..\\escape", false).is_err());
        } else {
            assert!(validate_relative_path("..\\literal", false).is_ok());
        }
        assert!(validate_portable_relative_path("..\\escape", false).is_err());
    }

    #[test]
    fn windows_filesystem_paths_only_allow_rooted_drive_colons() {
        assert!(!windows_filesystem_path_has_forbidden_colon(r"C:\payload"));
        assert!(!windows_filesystem_path_has_forbidden_colon("C:/payload"));
        assert!(!windows_filesystem_path_has_forbidden_colon(
            r"\\?\C:\payload"
        ));
        assert!(!windows_filesystem_path_has_forbidden_colon(
            r"\\.\C:\payload"
        ));

        assert!(windows_filesystem_path_has_forbidden_colon("C:payload"));
        assert!(windows_filesystem_path_has_forbidden_colon(
            r"C:\payload:hidden"
        ));
        assert!(windows_filesystem_path_has_forbidden_colon(
            r"\\server\share\payload:hidden"
        ));
        assert!(windows_filesystem_path_has_forbidden_colon(
            r"\\?\UNC\server\share\payload:hidden"
        ));
        assert!(windows_filesystem_path_has_forbidden_colon(
            r"directory::$INDEX_ALLOCATION"
        ));
    }

    #[test]
    fn host_relative_paths_apply_windows_colon_rules() {
        if cfg!(windows) {
            assert!(validate_relative_path("payload:hidden", false).is_err());
            assert!(validate_portable_relative_path("payload:hidden", false).is_err());
            assert!(validate_windows_filesystem_path(r"C:\payload:hidden").is_err());
            assert!(validate_windows_filesystem_path(r"C:\payload").is_ok());
        } else {
            assert!(validate_relative_path("payload:hidden", false).is_ok());
            assert!(validate_portable_relative_path("payload:hidden", false).is_ok());
            assert!(validate_windows_filesystem_path("payload:hidden").is_ok());
        }
    }
}

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;
