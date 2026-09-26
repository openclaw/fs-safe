//! One existing regular Windows file. Receipts describe facts, never authority.
use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use crate::{NativeResult, native_error, exact_identity_component};
use crate::windows::OwnedHandle;
#[path = "retained_file_windows.rs"]
mod os;

#[derive(Clone)]
#[napi(object)]
pub struct RetainedFileIssue { pub phase: String, pub code: String, pub message: String }

#[derive(Clone)]
#[napi(object)]
pub struct RetainedFileResult {
    pub status: String,
    pub phase: String,
    pub identity: Option<String>,
    pub disposition: String,
    pub namespace: String,
    pub resources: String,
    pub persistence: String,
    pub errors: Vec<RetainedFileIssue>,
}
impl RetainedFileResult {
    fn new() -> Self { Self { status: "not-attempted".into(), phase: "admission".into(), identity: None,
        disposition: "not-attempted".into(), namespace: "not-observed".into(), resources: "closed".into(),
        persistence: "not-proven".into(), errors: Vec::new() } }
    fn error(&mut self, phase: &str, error: napi::Error<String>) {
        self.errors.push(RetainedFileIssue { phase: phase.into(), code: error.status, message: error.reason });
    }
}

struct Owner {
    parents: Vec<OwnedHandle>, file: Option<OwnedHandle>, path: String, name: String,
    dev: u64, ino: u64, parent_dev: u64, parent_ino: u64, size: u64, mtime_ns: u64, ctime_ns: u64, digest: String,
}
impl Owner {
    fn parent(&self) -> &OwnedHandle { self.parents.last().expect("admitted parent") }
    fn admit(&mut self, result: &mut RetainedFileResult) -> NativeResult<()> {
        let parts = os::path_parts(&self.path)?;
        os::basename(&self.name)?;
        self.parents.push(os::root(&self.path[..3])?);
        os::check_directory(self.parent().0)?;
        os::check_ntfs(self.parent().0)?;
        for part in parts {
            let next = os::directory(self.parent().0, part)?;
            self.parents.push(next);
            os::check_directory(self.parent().0)?;
        }
        os::canonical(self.parent().0, &self.path)?;
        os::exact(self.parent().0, self.parent_dev, self.parent_ino, true)?;
        self.file = Some(os::file(self.parent().0, &self.name)?);
        let file = self.file.as_ref().unwrap();
        result.identity = Some(os::exact(file.0, self.dev, self.ino, false)?);
        os::regular(file.0, self.size)?;
        os::stamps(file.0, self.mtime_ns, self.ctime_ns)?;
        os::no_named_streams(file.0)?;
        os::exclude_writable_sections(file.0, result)?;
        self.current()
    }
    fn current(&self) -> NativeResult<()> {
        os::canonical(self.parent().0, &self.path)?;
        os::exact(self.parent().0, self.parent_dev, self.parent_ino, true)?;
        let file = self.file.as_ref().expect("admitted file");
        os::exact(file.0, self.dev, self.ino, false)?;
        os::regular(file.0, self.size)?;
        os::stamps(file.0, self.mtime_ns, self.ctime_ns)?;
        os::no_named_streams(file.0)?;
        if os::digest(file.0, self.size)? != self.digest {
            return Err(native_error("path-mismatch", "retained bytes do not match producer digest"));
        }
        Ok(())
    }
    fn close_file(&mut self, result: &mut RetainedFileResult) {
        if let Some(file) = self.file.take() {
            if let Err(error) = file.close() { result.resources = "close-failed".into(); result.error("close-file", error); }
        }
    }
    fn close(&mut self, result: &mut RetainedFileResult) {
        self.close_file(result);
        while let Some(parent) = self.parents.pop() {
            if let Err(error) = parent.close() { result.resources = "close-failed".into(); result.error("close-parent", error); }
        }
    }
    fn observe(&self, result: &mut RetainedFileResult) {
        match os::file(self.parent().0, &self.name) {
            Err(error) if error.status == "ENOENT" => { result.namespace = "absent".into(); result.status = "name-absent-after-settlement".into(); },
            Err(error) => { result.namespace = "unknown".into(); result.error("observe", error); },
            Ok(file) => {
                result.namespace = match os::exact(file.0, self.dev, self.ino, false) { Ok(_) => "original", Err(_) => "foreign" }.into();
                if let Err(error) = file.close() { result.resources = "close-failed".into(); result.error("close-observation", error); }
            },
        }
    }
}

#[napi]
pub struct NativeRetainedFile { owner: Option<Owner>, result: RetainedFileResult }

#[napi]
impl NativeRetainedFile {
    #[napi(getter)]
    pub fn admission(&self) -> RetainedFileResult { self.result.clone() }

    #[napi]
    pub fn settle(&mut self, remove: bool) -> RetainedFileResult {
        let Some(mut owner) = self.owner.take() else { return self.result.clone(); };
        let result = &mut self.result;
        result.phase = if remove { "disposition" } else { "dispose" }.into();
        result.status = "not-attempted".into();
        result.resources = "closed".into();
        if remove {
            match owner.current() {
                Err(error) => { result.status = if error.status == "path-mismatch" { "preserved-mismatch" } else { "failed" }.into(); result.error("verify", error); },
                Ok(()) => match os::disposition(owner.file.as_ref().unwrap().0) {
                    Ok(()) => { result.disposition = "accepted".into(); result.status = "disposition-accepted".into(); },
                    Err(error) => {
                        // Only documented refusal classes establish a non-effect.
                        let refused = matches!(error.status.as_str(), "EACCES" | "EPERM" | "ENOTSUP" | "EINVAL" | "EBUSY");
                        result.disposition = if refused { "rejected" } else { "indeterminate" }.into();
                        result.status = if refused { "failed" } else { "indeterminate" }.into();
                        result.error("disposition", error);
                    },
                },
            }
        }
        owner.close_file(result);
        if result.disposition == "accepted" && result.resources == "closed" { owner.observe(result); }
        owner.close(result);
        if result.resources == "close-failed" { result.status = "indeterminate".into(); }
        result.clone()
    }
}

impl Drop for NativeRetainedFile {
    fn drop(&mut self) {
        // GC is resource cleanup only. Explicit disposal is required for a receipt.
        if let Some(mut owner) = self.owner.take() { owner.close(&mut self.result); }
    }
}

#[napi(js_name = "retainWindowsFile")]
#[allow(clippy::too_many_arguments)]
pub fn retain_windows_file(path: String, name: String, parent_dev: BigInt, parent_ino: BigInt,
    dev: BigInt, ino: BigInt, size: BigInt, mtime_ns: BigInt, ctime_ns: BigInt, digest: String, max_bytes: u32) -> NativeRetainedFile {
    let mut result = RetainedFileResult::new();
    let mut owner = None;
    let admission = (|| -> NativeResult<()> {
        let size = exact_identity_component(&size, "size")?;
        if max_bytes == 0 || max_bytes > 64 * 1024 * 1024 || size > max_bytes as u64 || digest.len() != 64
            || !digest.bytes().all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x)) {
            return Err(native_error("EINVAL", "invalid bounded retained-file digest contract"));
        }
        owner = Some(Owner { parents: Vec::new(), file: None, path, name,
            dev: exact_identity_component(&dev, "device")?, ino: exact_identity_component(&ino, "inode")?,
            parent_dev: exact_identity_component(&parent_dev, "parent device")?, parent_ino: exact_identity_component(&parent_ino, "parent inode")?, size, mtime_ns: exact_identity_component(&mtime_ns, "mtimeNs")?,
            ctime_ns: exact_identity_component(&ctime_ns, "ctimeNs")?, digest });
        owner.as_mut().unwrap().admit(&mut result)
    })();
    match admission {
        Ok(()) => { result.status = "retained".into(); result.resources = "held".into(); },
        Err(error) => {
            result.status = match error.status.as_str() { "path-mismatch" => "preserved-mismatch", "ENOTSUP" => "unsupported", _ => "failed" }.into();
            result.error("admission", error);
            if let Some(mut failed) = owner.take() { failed.close(&mut result); }
            if result.resources == "close-failed" { result.status = "indeterminate".into(); }
        },
    }
    NativeRetainedFile { owner, result }
}

#[cfg(test)]
#[path = "retained_file_tests.rs"]
mod tests;
