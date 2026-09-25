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
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod staged_symlink;
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

pub(crate) fn native_error(code: impl Into<String>, message: impl ToString) -> Error<String> {
    Error::new(code.into(), message)
}

fn invalid_path(message: impl ToString) -> Error<String> {
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
