use napi::bindgen_prelude::*;
use napi_derive::napi;
use windows_sys::Wdk::Storage::FileSystem::FILE_OPEN;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_READ_ATTRIBUTES};
use crate::{ExactFileIdentity, NativeResult, into_napi, native_error, validate_child_basename};
use crate::windows::{OwnedHandle, ReparsePolicy, handle_identity, handle_is_reparse,
    mark_handle_for_deletion, nt_open_relative_with_policy, root_handle};

#[napi(object)]
pub struct WindowsRootRemovalEntry {
    pub dev: BigInt,
    pub ino: BigInt,
    pub directory: bool,
    pub symlink: bool,
}

fn open(parent: HANDLE, name: &str, access: u32) -> NativeResult<OwnedHandle> {
    validate_child_basename(name)?;
    nt_open_relative_with_policy(parent, name, access | FILE_READ_ATTRIBUTES, FILE_OPEN, 0, ReparsePolicy::AllowLeaf)
}

fn inspect(handle: HANDLE) -> NativeResult<(ExactFileIdentity, bool, bool)> {
    let (dev, ino, directory) = handle_identity(handle)?;
    if dev == 0 || ino == 0 { return Err(native_error("path-mismatch", "removal identity is unknown")); }
    let reparse = handle_is_reparse(handle)?;
    Ok((ExactFileIdentity { dev: u64::from(dev), ino }, directory && !reparse, reparse))
}

#[napi(js_name = "rootRemovalStat")]
pub fn root_removal_stat(env: Env, parent: i32, name: String) -> Result<WindowsRootRemovalEntry> {
    into_napi(env, (|| {
        let child = open(root_handle(parent)?, &name, 0)?;
        let (identity, directory, symlink) = inspect(child.0)?;
        Ok(WindowsRootRemovalEntry { dev: BigInt::from(identity.dev), ino: BigInt::from(identity.ino), directory, symlink })
    })())
}

fn unlink_with_hook(parent: HANDLE, name: &str, expected: ExactFileIdentity, directory: bool, before_final: impl FnOnce()) -> NativeResult<()> {
    validate_child_basename(name)?;
    before_final();
    let child = open(parent, name, DELETE)?;
    let (identity, is_directory, _) = inspect(child.0)?;
    if identity != expected || is_directory != directory {
        return Err(native_error("path-mismatch", "removal entry changed"));
    }
    // Disposition applies to this exact opened object, including a reparse leaf.
    mark_handle_for_deletion(child.0)
}

#[napi(js_name = "rootRemovalUnlink")]
pub fn root_removal_unlink(env: Env, parent: i32, name: String, dev: BigInt, ino: BigInt, directory: bool) -> Result<()> {
    into_napi(env, (|| {
        unlink_with_hook(root_handle(parent)?, &name, crate::exact_file_identity(&dev, &ino)?, directory, || {})
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, time::{SystemTime, UNIX_EPOCH}};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};

    #[test]
    fn removes_exact_files_and_empty_directories_and_preserves_replacements() {
        let base = std::env::temp_dir().join(format!("fs-safe-root-remove-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&base).unwrap();
        let parent = fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).open(&base).unwrap();
        let handle = parent.as_raw_handle() as HANDLE;
        fs::write(base.join("file"), b"original").unwrap();
        let identity = { let child = open(handle, "file", 0).unwrap(); inspect(child.0).unwrap().0 };
        let error = unlink_with_hook(handle, "file", identity, false, || {
            fs::rename(base.join("file"), base.join("held")).unwrap();
            fs::write(base.join("file"), b"replacement").unwrap();
        }).unwrap_err();
        assert_eq!(error.status, "path-mismatch");
        assert_eq!(fs::read(base.join("file")).unwrap(), b"replacement");
        let identity = { let child = open(handle, "file", 0).unwrap(); inspect(child.0).unwrap().0 };
        unlink_with_hook(handle, "file", identity, false, || {}).unwrap();
        assert!(!base.join("file").exists());
        fs::create_dir(base.join("directory")).unwrap();
        let identity = { let child = open(handle, "directory", 0).unwrap(); inspect(child.0).unwrap().0 };
        unlink_with_hook(handle, "directory", identity, true, || {}).unwrap();
        assert!(!base.join("directory").exists());
        drop(parent);
        fs::remove_dir_all(base).unwrap();
    }
}
