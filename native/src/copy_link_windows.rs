use napi::{Env, Result, bindgen_prelude::BigInt};
use napi_derive::napi;
use windows_sys::Wdk::Storage::FileSystem::{FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
};
use crate::clone_windows::{clone_reparse, metadata, set_metadata};
use crate::windows::{
    OwnedHandle, ReparsePolicy, guarded_handle_information, handle_identity,
    mark_clone_handle_for_deletion, nt_open_relative_with_policy, root_handle,
    set_rename_information,
};
use crate::{NativeResult, exact_identity_component, into_napi, native_error, validate_child_basename};

#[napi(object)]
pub struct CopyLinkIdentity { pub dev: BigInt, pub ino: BigInt }

fn check_identity(handle: &OwnedHandle, dev: u64, ino: u64) -> NativeResult<()> {
    let (actual_dev, actual_ino, _) = handle_identity(handle.0)?;
    let info = guarded_handle_information(handle.0, "inspect copy link")?;
    if actual_dev as u64 != dev || actual_ino != ino
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
    {
        return Err(native_error("path-mismatch", "copy link identity changed"));
    }
    Ok(())
}

#[napi(js_name = "copyLinkExclusive")]
pub fn copy_link_exclusive(env: Env, source_parent: i32, source_name: String,
    parent: i32, name: String, dev: BigInt, ino: BigInt, preserve_metadata: bool, mode: u32,
) -> Result<CopyLinkIdentity> {
    into_napi(env, (|| {
        validate_child_basename(&source_name)?;
        validate_child_basename(&name)?;
        let source = nt_open_relative_with_policy(root_handle(source_parent)?, &source_name,
            FILE_GENERIC_READ, FILE_OPEN, 0, ReparsePolicy::AllowLeaf)?;
        check_identity(&source, exact_identity_component(&dev, "device")?, exact_identity_component(&ino, "inode")?)?;
        let info = guarded_handle_information(source.0, "inspect source link type")?;
        let before = metadata(source.0)?;
        let target = nt_open_relative_with_policy(root_handle(parent)?, &name,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE, FILE_CREATE,
            if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 { FILE_DIRECTORY_FILE } else { 0 },
            ReparsePolicy::Reject)?;
        let result = (|| {
            clone_reparse(source.0, target.0)?;
            let mut copied = if preserve_metadata { before } else { metadata(target.0)? };
            copied.FileAttributes = (copied.FileAttributes & 0x3126)
                | if mode & 0o200 == 0 { 1 } else { 0 };
            set_metadata(target.0, copied)?;
            let after = metadata(source.0)?;
            if before.LastWriteTime != after.LastWriteTime || before.ChangeTime != after.ChangeTime {
                return Err(native_error("path-mismatch", "copy source link changed"));
            }
            let (dev, ino, _) = handle_identity(target.0)?;
            Ok(CopyLinkIdentity { dev: BigInt::from(dev as u64), ino: BigInt::from(ino) })
        })();
        if result.is_err() { mark_clone_handle_for_deletion(target.0)?; }
        result
    })())
}

#[napi(js_name = "publishCopyLink")]
pub fn publish_copy_link(env: Env, parent: i32, name: String, destination: String,
    dev: BigInt, ino: BigInt,
) -> Result<()> {
    into_napi(env, (|| {
        validate_child_basename(&name)?;
        validate_child_basename(&destination)?;
        let parent = root_handle(parent)?;
        let source = nt_open_relative_with_policy(parent, &name, FILE_READ_ATTRIBUTES | DELETE,
            FILE_OPEN, 0, ReparsePolicy::AllowLeaf)?;
        check_identity(&source, exact_identity_component(&dev, "device")?, exact_identity_component(&ino, "inode")?)?;
        set_rename_information(source.0, parent, &destination, false, "publish copied link exclusively")
    })())
}

#[napi(js_name = "removeCopyLink")]
pub fn remove_copy_link(env: Env, parent: i32, name: String, dev: BigInt, ino: BigInt) -> Result<()> {
    into_napi(env, (|| {
        validate_child_basename(&name)?;
        let source = nt_open_relative_with_policy(root_handle(parent)?, &name, FILE_READ_ATTRIBUTES | DELETE,
            FILE_OPEN, 0, ReparsePolicy::AllowLeaf)?;
        check_identity(&source, exact_identity_component(&dev, "device")?, exact_identity_component(&ino, "inode")?)?;
        mark_clone_handle_for_deletion(source.0)
    })())
}
