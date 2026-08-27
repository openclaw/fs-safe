#![deny(unsafe_op_in_unsafe_fn)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod archive;
mod fast_file;
mod tar_meter;
mod tar_pax;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
mod windows_security;

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

fn validate_relative_path_with_separators(
    path: &str,
    allow_root: bool,
    backslash_is_separator: bool,
) -> NativeResult<()> {
    if path.as_bytes().contains(&0) {
        return Err(invalid_path("relative path contains a NUL byte"));
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

fn into_napi<T>(env: Env, result: NativeResult<T>) -> Result<T> {
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
pub use windows_security::{
    WindowsAccessControlEntry, WindowsAceFlags, WindowsSecurityFacts, create_private_directory,
    read_owner_and_dacl,
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
}

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;
