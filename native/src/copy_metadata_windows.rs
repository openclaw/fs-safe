use napi::bindgen_prelude::Buffer;
use napi::{Env, Result};
use napi_derive::napi;
use windows_sys::Win32::Storage::FileSystem::FILE_BASIC_INFO;

use crate::clone_windows::{metadata, set_metadata};
use crate::windows::root_handle;
use crate::{into_napi, native_error};

#[napi(js_name = "readCopyMetadata")]
pub fn read_copy_metadata(env: Env, fd: i32) -> Result<Buffer> {
    into_napi(env, (|| {
        let info = metadata(root_handle(fd)?)?;
        let mut bytes = Vec::with_capacity(28);
        bytes.extend_from_slice(&info.CreationTime.to_le_bytes());
        bytes.extend_from_slice(&info.LastAccessTime.to_le_bytes());
        bytes.extend_from_slice(&info.LastWriteTime.to_le_bytes());
        bytes.extend_from_slice(&info.FileAttributes.to_le_bytes());
        Ok(bytes.into())
    })())
}

#[napi(js_name = "restoreCopyMetadata")]
pub fn restore_copy_metadata(env: Env, fd: i32, snapshot: Buffer) -> Result<()> {
    into_napi(env, (|| {
        if snapshot.len() != 28 {
            return Err(native_error("EINVAL", "invalid copy metadata snapshot"));
        }
        let handle = root_handle(fd)?;
        let attributes = u32::from_le_bytes(snapshot[24..28].try_into().unwrap());
        // READONLY remains owned by Root's mode policy. The tree copier's
        // shared setter excludes reparse, integrity and sparse FSCTL flags.
        let readonly = metadata(handle)?.FileAttributes & 1;
        set_metadata(handle, FILE_BASIC_INFO {
            CreationTime: i64::from_le_bytes(snapshot[0..8].try_into().unwrap()),
            LastAccessTime: i64::from_le_bytes(snapshot[8..16].try_into().unwrap()),
            LastWriteTime: i64::from_le_bytes(snapshot[16..24].try_into().unwrap()),
            ChangeTime: 0,
            FileAttributes: (attributes & 0x3126) | readonly,
        })
    })())
}
