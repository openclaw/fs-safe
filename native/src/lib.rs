#![deny(unsafe_op_in_unsafe_fn)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod archive;
mod archive_gzip;
mod task;
mod fast_file;
mod clone_tree;
mod clone_metadata;
mod directory_observation;
#[cfg(target_os = "linux")]
mod clone_linux;
#[cfg(unix)]
mod clone_unix;
#[cfg(windows)]
mod clone_windows;
#[cfg(any(target_os = "linux", windows))]
mod copy_contents;
#[cfg(windows)]
mod copy_windows;
#[cfg(target_os = "linux")]
mod copy_linux;
#[cfg(unix)]
mod file_copy;
mod owned_tree;
#[cfg(unix)]
mod realpath;
#[cfg(target_os = "macos")]
mod darwin_security;
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
pub struct DirectoryObservation {
    pub dev: BigInt,
    pub ino: BigInt,
    pub real_path: String,
}

#[cfg(unix)]
#[napi(object)]
pub struct DirectoryFdObservation {
    pub dev: BigInt,
    pub ino: BigInt,
    pub mode: BigInt,
    pub nlink: BigInt,
    pub real_path: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ExactFileIdentity {
    pub dev: u64,
    pub ino: u64,
}

#[cfg(windows)]
pub(crate) const RENAME_SOURCE_IDENTITY_MISMATCH: &str =
    "FS_SAFE_INTERNAL_RENAME_SOURCE_IDENTITY_MISMATCH";

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

fn exact_identity_component(value: &BigInt, label: &str) -> NativeResult<u64> {
    let (negative, value, lossless) = value.get_u64();
    if negative || !lossless {
        return Err(invalid_path(format!(
            "expected source {label} must be an unsigned 64-bit bigint",
        )));
    }
    Ok(value)
}

fn exact_file_identity(dev: &BigInt, ino: &BigInt) -> NativeResult<ExactFileIdentity> {
    Ok(ExactFileIdentity {
        dev: exact_identity_component(dev, "device")?,
        ino: exact_identity_component(ino, "inode")?,
    })
}

fn windows_filesystem_path_has_forbidden_colon(path: &str) -> bool {
    // A rooted ASCII drive designator is the only colon-bearing Windows
    // filesystem syntax that is not an alternate stream or namespace alias.
    // Keep device-path policy separate: recognizing \\.\C:\ here does not
    // authorize device paths at any call site that already rejects them.
    let bytes = match path.as_bytes() {
        [
            b'\\' | b'/',
            b'\\' | b'/',
            b'?' | b'.',
            b'\\' | b'/',
            rest @ ..,
        ] => rest,
        bytes => bytes,
    };
    let remaining = match bytes {
        [drive, b':', b'\\' | b'/', rest @ ..] if drive.is_ascii_alphabetic() => rest,
        bytes => bytes,
    };
    remaining.contains(&b':')
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

pub(crate) fn validate_child_basename(path: &str) -> NativeResult<()> {
    validate_relative_path(path, false)?;
    if path.contains('/') || (cfg!(windows) && path.contains('\\')) {
        return Err(invalid_path("operation requires one direct-child basename"));
    }
    Ok(())
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

#[napi(js_name = "closeOwnedFd")]
pub fn close_owned_fd(env: Env, fd: i32) -> Result<()> {
    into_napi(env, platform::close_owned_fd(fd))
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

#[napi(js_name = "mkdirChildBeneath")]
pub fn mkdir_child_beneath(
    env: Env,
    parent_fd: i32,
    basename: String,
    mode: u32,
) -> Result<bool> {
    into_napi(
        env,
        validate_child_basename(&basename)
            .and_then(|()| platform::mkdir_child_beneath(parent_fd, &basename, mode)),
    )
}

macro_rules! native_path_pair_operation {
    ($name:ident, $js_name:literal) => {
        #[napi(js_name = $js_name)]
        pub fn $name(
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
                        platform::$name(
                            source_root_fd,
                            &source_rel_path,
                            target_root_fd,
                            &target_rel_path,
                        )
                    }),
            )
        }
    };
}

native_path_pair_operation!(link_beneath, "linkBeneath");
native_path_pair_operation!(rename_no_replace, "renameNoReplace");

#[napi(js_name = "renameNoReplaceWithIdentity")]
pub fn rename_no_replace_with_identity(
    env: Env,
    source_root_fd: i32,
    source_rel_path: String,
    target_root_fd: i32,
    target_rel_path: String,
    expected_source_dev: BigInt,
    expected_source_ino: BigInt,
) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&source_rel_path, false)
            .and_then(|()| validate_relative_path(&target_rel_path, false))
            .and_then(|()| exact_file_identity(&expected_source_dev, &expected_source_ino))
            .and_then(|expected_source_identity| {
                platform::rename_no_replace_with_identity(
                    source_root_fd,
                    &source_rel_path,
                    target_root_fd,
                    &target_rel_path,
                    expected_source_identity,
                )
            }),
    )
}

native_path_pair_operation!(rename_replace, "renameReplace");

#[napi(js_name = "fstatIdentity")]
pub fn fstat_identity(env: Env, fd: i32) -> Result<FileIdentity> {
    into_napi(env, platform::fstat_identity(fd))
}

#[napi(js_name = "observeDirectory")]
pub fn observe_directory(env: Env, path: String) -> Result<DirectoryObservation> {
    into_napi(
        env,
        directory_observation::observe_directory(&path).map(|observed| DirectoryObservation {
            dev: BigInt::from(observed.dev),
            ino: BigInt::from(observed.ino),
            real_path: observed.real_path,
        }),
    )
}

#[cfg(unix)]
#[napi(js_name = "observeDirectoryFd")]
pub fn observe_directory_fd(
    env: Env,
    fd: i32,
    expected_path: String,
) -> Result<DirectoryFdObservation> {
    into_napi(
        env,
        directory_observation::observe_directory_fd(fd, &expected_path)
            .map(|observed| DirectoryFdObservation {
                dev: BigInt::from(observed.dev),
                ino: BigInt::from(observed.ino),
                mode: BigInt::from(u64::from(observed.mode)),
                nlink: BigInt::from(observed.nlink),
                real_path: observed.real_path,
            }),
    )
}

pub use archive::{
    NativeArchiveEntry, NativeArchivePlanEntry, extract_archive_native, inspect_archive_native,
    read_archive_entry_native,
};
pub use fast_file::{
    FileHash, NativeCopyResult, clone_file_exclusive, copy_file_range_exclusive, sha256_file,
};
#[cfg(any(target_os = "linux", windows))]
pub use copy_contents::copy_file_contents;
#[cfg(unix)]
pub use file_copy::{NativeFileCopyResult, copy_file_exclusive};
pub use owned_tree::{
    NativeOwnedTreeRemovalResult, owned_tree_removal_available, remove_owned_tree,
    remove_owned_tree_sync,
};
#[cfg(unix)]
pub use staged_file::{create_staged_file, remove_staged_file, staged_file_matches};
pub use windows_security::{
    WindowsAccessControlEntry, WindowsAceFlags, WindowsIdentityReceipt, WindowsSecurityFacts,
    create_private_directory, create_private_directory_with_parent_identity,
    inspect_windows_directory, protect_private_windows_file, read_owner_and_dacl,
    verify_private_windows_file,
};
pub use windows_secure_file::{
    WindowsDescriptorSecurityFacts, inspect_windows_secure_file_handle,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_identity_inputs_require_lossless_unsigned_components() {
        assert_eq!(
            exact_file_identity(&BigInt::from(u64::MAX), &BigInt::from(0_u64)).unwrap(),
            ExactFileIdentity {
                dev: u64::MAX,
                ino: 0,
            },
        );
        assert!(exact_file_identity(&BigInt::from(-1_i64), &BigInt::from(1_u64)).is_err());
        assert!(
            exact_file_identity(
                &BigInt {
                    sign_bit: false,
                    words: vec![0, 1],
                },
                &BigInt::from(1_u64),
            )
            .is_err()
        );
    }

    #[test]
    fn filesystem_paths_follow_host_separator_rules() {
        assert!(validate_relative_path("../escape", false).is_err());
        if cfg!(windows) {
            assert!(validate_relative_path("..\\escape", false).is_err());
            assert!(validate_child_basename("literal\\child").is_err());
        } else {
            assert!(validate_relative_path("..\\literal", false).is_ok());
            assert!(validate_child_basename("literal\\child").is_ok());
        }
        assert!(validate_portable_relative_path("..\\escape", false).is_err());
        for invalid in ["", ".", "..", "nested/child", "nul\0child"] {
            assert!(validate_child_basename(invalid).is_err());
        }
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
    fn windows_colon_policy_preserves_opaque_suffixes_and_namespace_boundaries() {
        for (path, forbidden) in [
            ("", false),
            (":", true),
            ("C:", true),
            ("C:/", false),
            (r"\\?\", false),
            (r"\\?\C", false),
            (r"\\?\C:", true),
            (r"\\?\C:/", false),
            (r"\\?\\\?\C:/payload", true),
            (r"\\?\\\?\payload", false),
            (r"\\.\C:/payload", false),
            (r"\\server\share\payload", false),
            (r"\\?\UNC\server\share:stream", true),
            (r"\\?\Volume{example}\payload", false),
            ("C:/part:stream/../payload", true),
            ("C:/part/../payload", false),
            ("C:/payload:", true),
            ("C:/payload::$INDEX_ALLOCATION", true),
            ("é:/payload", true),
            ("K:/payload", true),
            ("ſ:/payload", true),
            ("ı:/payload", true),
            ("🦀:/payload", true),
            ("Ｃ:/payload", true),
            ("C:／payload", true),
            ("C：/payload", false),
            ("C:/é-🦀", false),
            (r"\\?\C:/é-🦀", false),
            ("\0", false),
            ("C:/\0payload", false),
            ("C:/\0payload:stream", true),
            ("C:\0payload", true),
        ] {
            assert_eq!(
                windows_filesystem_path_has_forbidden_colon(path),
                forbidden,
                "{path:?}",
            );
        }
    }

    #[test]
    fn windows_colon_policy_matches_original_offset_reference() {
        fn reference(path: &str) -> bool {
            let bytes = path.as_bytes();
            let mut colons = bytes
                .iter()
                .enumerate()
                .filter_map(|(index, byte)| (*byte == b':').then_some(index));
            let Some(colon) = colons.next() else {
                return false;
            };
            if colons.next().is_some() {
                return true;
            }
            let separator = |byte: u8| byte == b'/' || byte == b'\\';
            let drive_start = match colon {
                1 => 0,
                5 if separator(bytes[0])
                    && separator(bytes[1])
                    && (bytes[2] == b'?' || bytes[2] == b'.')
                    && separator(bytes[3]) =>
                {
                    4
                }
                _ => return true,
            };
            !(matches!(bytes[drive_start], b'A'..=b'Z' | b'a'..=b'z')
                && bytes.get(colon + 1).is_some_and(|byte| separator(*byte)))
        }

        let check = |path: &str| {
            assert_eq!(
                windows_filesystem_path_has_forbidden_colon(path),
                reference(path),
                "{path:?}",
            );
        };
        let mut prefixes = vec![String::new()];
        for first in ['/', '\\'] {
            for second in ['/', '\\'] {
                for marker in ['?', '.'] {
                    for fourth in ['/', '\\'] {
                        prefixes.push(format!("{first}{second}{marker}{fourth}"));
                    }
                }
            }
        }
        for prefix in &prefixes {
            for root in ['/', '\\'] {
                let path = format!("{prefix}C:{root}payload");
                for end in 0..=path.len() {
                    check(&path[..end]);
                    check(&format!("{}:{}", &path[..end], &path[end..]));
                }
                for position in 0..path.len() {
                    for byte in 0..=127 {
                        let mut mutated = path.as_bytes().to_vec();
                        mutated[position] = byte;
                        check(std::str::from_utf8(&mutated).unwrap());
                    }
                }
                for repeated in &prefixes {
                    check(&format!("{repeated}{path}"));
                }
            }
        }
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
        let path = "C:/\0payload:stream";
        if cfg!(windows) {
            let error = validate_windows_filesystem_path(path).unwrap_err();
            assert_eq!(error.status, "EINVAL");
            assert_eq!(
                error.reason,
                "Windows filesystem path contains alternate stream syntax",
            );
        } else {
            assert!(validate_windows_filesystem_path(path).is_ok());
        }
        let error = validate_relative_path(path, false).unwrap_err();
        assert_eq!(error.status, "EINVAL");
        assert_eq!(error.reason, "relative path contains a NUL byte");
    }
}

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;
