use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi_derive::napi;

use crate::task::NativeTask;

#[cfg(target_os = "macos")]
fn metadata(path: &str) -> Option<Buffer> {
    let path = std::ffi::CString::new(path).ok()?;
    let mut attributes: libc::attrlist = unsafe { std::mem::zeroed() };
    attributes.bitmapcount = 5;
    attributes.commonattr = 0x8203_8c0a;
    attributes.fileattr = 0x200;
    attributes.forkattr = 0x100;
    let mut result = [0u8; 100];
    // Darwin packs getattrlist results at four-byte boundaries. Keep the kernel
    // snapshot intact; the TypeScript decoder checks every returned attribute.
    let status = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            (&mut attributes as *mut libc::attrlist).cast(),
            result.as_mut_ptr().cast(),
            result.len(),
            0x21,
        )
    };
    (status == 0).then(|| result.to_vec().into())
}

#[cfg(not(target_os = "macos"))]
fn metadata(_path: &str) -> Option<Buffer> {
    None
}

#[napi(js_name = "readCloneFileMetadata")]
pub fn read_clone_file_metadata(paths: Vec<String>) -> AsyncTask<NativeTask<Vec<Option<Buffer>>>> {
    AsyncTask::new(NativeTask::new(move || {
        Ok(paths.iter().map(|path| metadata(path)).collect())
    }))
}
