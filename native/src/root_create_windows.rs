use napi::{Env, Result};
use napi_derive::napi;
use windows_sys::Wdk::Storage::FileSystem::{FILE_OPEN, FILE_NON_DIRECTORY_FILE};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES};
use crate::{NativeResult, into_napi, validate_child_basename};
use crate::windows::{ReparsePolicy, handle_identity, handle_is_reparse, mark_handle_for_deletion,
    nt_open_relative_with_policy, root_handle};

fn remove(parent: HANDLE, name: &str, expected: HANDLE) -> NativeResult<String> {
    validate_child_basename(name)?;
    let expected_identity = handle_identity(expected)?;
    if expected_identity.0 == 0 || expected_identity.1 == 0 || expected_identity.2 || handle_is_reparse(expected)? {
        return Ok("preserved".into());
    }
    let child = match nt_open_relative_with_policy(parent, name,
        DELETE | FILE_READ_ATTRIBUTES, FILE_OPEN,
        FILE_NON_DIRECTORY_FILE, ReparsePolicy::Reject) {
        Ok(child) => child,
        Err(error) if error.status == "ENOENT" => return Ok("name-absent".into()),
        Err(error) if matches!(error.status.as_str(), "ENOTDIR" | "EISDIR" | "ELOOP") => return Ok("preserved".into()),
        Err(error) => return Err(error),
    };
    if handle_identity(child.0)? != expected_identity { return Ok("preserved".into()); }
    mark_handle_for_deletion(child.0)?;
    Ok("removed".into())
}

#[napi(js_name = "removeStagedFile")]
pub fn remove_staged_file(env: Env, parent: i32, name: String, file: i32) -> Result<String> {
    into_napi(env, (|| remove(root_handle(parent)?, &name, root_handle(file)?))())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, time::{SystemTime, UNIX_EPOCH}};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_GENERIC_READ, FILE_GENERIC_WRITE};
    use windows_sys::Wdk::Storage::FileSystem::FILE_CREATE;

    #[test]
    fn cleanup_retains_the_parent_and_preserves_a_replacement_file() {
        let base = std::env::temp_dir().join(format!("fs-safe-create-cleanup-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(base.join("parent")).unwrap();
        let sharing = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let parent = fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .share_mode(sharing).open(base.join("parent")).unwrap();
        // Win32 may refuse to rename a directory containing open files. Swap
        // the empty parent first, then create and clean through its retained handle.
        fs::rename(base.join("parent"), base.join("held")).unwrap();
        let file = nt_open_relative_with_policy(parent.as_raw_handle() as HANDLE, "file",
            FILE_GENERIC_READ | FILE_GENERIC_WRITE, FILE_CREATE, FILE_NON_DIRECTORY_FILE, ReparsePolicy::Reject).unwrap();
        fs::create_dir(base.join("parent")).unwrap();
        fs::write(base.join("parent/file"), b"replacement").unwrap();
        assert_eq!(remove(parent.as_raw_handle() as HANDLE, "file", file.0).unwrap(), "removed");
        assert_eq!(fs::read(base.join("parent/file")).unwrap(), b"replacement");
        assert!(!base.join("held/file").exists());
        drop(file);
        drop(parent);
        fs::remove_dir_all(base).unwrap();
    }
}
