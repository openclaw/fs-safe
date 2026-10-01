//! One-way retained-handle publication on local NTFS. No delete or pathname fallback.
use napi::{bindgen_prelude::BigInt, Env, Result};
use napi_derive::napi;
use std::ptr::{null, null_mut};
use windows_sys::{Wdk::Storage::FileSystem::{FILE_DIRECTORY_FILE, FILE_SYNCHRONOUS_IO_NONALERT},
    Win32::{Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE}, Storage::FileSystem::*,
    System::{IO::DeviceIoControl, Ioctl::FSCTL_GET_REPARSE_POINT}}};
use crate::{exact_identity_component, into_napi, native_error, NativeResult};
use crate::windows::{OwnedHandle, guarded_handle_information, handle_file_identity, handle_identity_and_size, open_retained_child, set_rename_information, win_error};

#[derive(Clone)]
#[napi(object)]
pub struct PublicationError { pub code: String, pub message: String }
#[derive(Clone)]
#[napi(object)]
pub struct PublicationReply { pub outcome: String, pub error_code: Option<String>, pub error_message: Option<String> }
fn reply(outcome: &str, error: Option<napi::Error<String>>) -> PublicationReply {
    let (error_code, error_message) = match error { Some(e) => (Some(e.status), Some(e.reason)), None => (None, None) };
    PublicationReply { outcome: outcome.into(), error_code, error_message }
}
fn basename(name: &str) -> NativeResult<()> {
    crate::validate_child_basename(name)?;
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit()) {
        return Err(native_error("EINVAL", "publication requires an unambiguous Windows basename"));
    }
    Ok(())
}
fn path_parts(path: &str) -> NativeResult<Vec<&str>> {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1..3] != *b":\\" || path.contains('/') {
        return Err(native_error("ENOTSUP", "publication requires a canonical fixed local drive path"));
    }
    let parts = if path.len() == 3 { Vec::new() } else { path[3..].split('\\').collect::<Vec<_>>() };
    for part in &parts { basename(part)?; }
    Ok(parts)
}
const SHARING: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
fn child(parent: HANDLE, name: &str, access: u32, options: u32) -> NativeResult<OwnedHandle> {
    // Synchronous handles: NtSetInformationFile must complete before its reply.
    open_retained_child(parent, name, access, options | FILE_SYNCHRONOUS_IO_NONALERT, SHARING)
}
fn canonical(handle: HANDLE, expected: &str) -> NativeResult<()> {
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), buf.len() as u32, 0) } as usize;
    if n == 0 || n >= buf.len() { return Err(native_error("path-mismatch", "publication path unavailable")); }
    let actual = String::from_utf16(&buf[..n]).map_err(|_| native_error("ENOTSUP", "unrepresentable physical parent path"))?;
    if actual.strip_prefix(r"\\?\").unwrap_or(&actual) != expected {
        return Err(native_error("path-mismatch", "publication object has another physical spelling"));
    }
    Ok(())
}
fn ntfs(handle: HANDLE) -> NativeResult<()> {
    let mut name = [0u16; 32];
    if unsafe { GetVolumeInformationByHandleW(handle, null_mut(), 0, null_mut(), null_mut(), null_mut(), name.as_mut_ptr(), name.len() as u32) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "inspect publication filesystem"));
    }
    let n = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    if &name[..n] != [78, 84, 70, 83] { return Err(native_error("ENOTSUP", "publication requires local NTFS")); }
    Ok(())
}
fn physical_directory(handle: HANDLE) -> NativeResult<()> {
    let attrs = guarded_handle_information(handle, "inspect publication entry")?.dwFileAttributes;
    if attrs & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != FILE_ATTRIBUTE_DIRECTORY {
        return Err(native_error("path-mismatch", "publication parent is not a physical directory"));
    }
    Ok(())
}
fn exact(handle: HANDLE, dev: u64, ino: u64) -> NativeResult<()> {
    let ((d, i, _), _) = handle_identity_and_size(handle)?;
    if dev == 0 || ino == 0 || d == 0 || i == 0 { return Err(native_error("ENOTSUP", "unknown publication identity")); }
    if d as u64 != dev || i != ino { return Err(native_error("path-mismatch", "publication identity changed")); }
    // NTFS's public Node identity is the exact file reference number. Also require
    // the full native identity, used when comparing independent observed handles.
    handle_file_identity(handle)?;
    Ok(())
}
fn reparse_bytes(handle: HANDLE) -> NativeResult<Vec<u8>> {
    let mut bytes = vec![0u8; 16384]; let mut length = 0;
    if unsafe { DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, null(), 0, bytes.as_mut_ptr().cast(), bytes.len() as u32, &mut length, null_mut()) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "read publication reparse entry"));
    }
    if length < 8 || length as usize > bytes.len() { return Err(native_error("ENOTSUP", "invalid reparse receipt")); }
    bytes.truncate(length as usize);
    let tag = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    // Preserve the opaque buffer, including relative flag, print/substitute names
    // and UTF-16 target bytes. Never resolve or rebuild the target.
    if !matches!(tag, 0xa000000c | 0xa0000003) {
        return Err(native_error("ENOTSUP", "only symbolic-link and mount-point reparse entries are qualified"));
    }
    Ok(bytes)
}
fn entry(handle: HANDLE, kind: &str) -> NativeResult<Vec<u8>> {
    let info = guarded_handle_information(handle, "inspect publication entry")?;
    let reparse = info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if match kind { "symlink" => !reparse, "directory" => reparse || !directory, "file" => reparse || directory, _ => true } {
        return Err(native_error("not-file", "publication entry kind differs from original observation"));
    }
    if kind != "directory" && info.nNumberOfLinks != 1 { return Err(native_error("hardlink", "publication requires a single-link entry")); }
    if reparse { reparse_bytes(handle) } else { Ok(Vec::new()) }
}
struct Parent { path: String, dev: u64, ino: u64, chain: Vec<(String, OwnedHandle)> }
impl Parent {
    fn handle(&self) -> HANDLE { self.chain.last().expect("admitted parent").1.0 }
    fn open(&mut self) -> NativeResult<()> {
        let parts = path_parts(&self.path)?;
        let root = &self.path[..3]; let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(wide.as_ptr()) } != 3 { return Err(native_error("ENOTSUP", "publication requires a fixed local drive")); }
        let h = unsafe { CreateFileW(wide.as_ptr(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, SHARING, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if h == INVALID_HANDLE_VALUE { return Err(win_error(unsafe { GetLastError() }, "open publication root")); }
        self.chain.push((root.into(), OwnedHandle(h))); physical_directory(h)?; ntfs(h)?;
        let mut spelling = root.to_owned();
        for part in parts {
            let next = child(self.handle(), part, FILE_LIST_DIRECTORY, FILE_DIRECTORY_FILE)?;
            if !spelling.ends_with('\\') { spelling.push('\\'); } spelling.push_str(part);
            self.chain.push((spelling.clone(), next)); physical_directory(self.handle())?;
        }
        self.current()
    }
    fn current(&self) -> NativeResult<()> {
        for (path, handle) in &self.chain { physical_directory(handle.0)?; canonical(handle.0, path)?; }
        exact(self.handle(), self.dev, self.ino)?; ntfs(self.handle())
    }
}
struct Owner { source: Parent, target: Parent, name: String, target_name: String, dev: u64, ino: u64, kind: String,
    file: Option<OwnedHandle>, reparse: Vec<u8>, observations: Vec<OwnedHandle> }
impl Owner {
    fn file(&self) -> HANDLE { self.file.as_ref().expect("admitted entry").0 }
    fn admit(&mut self) -> NativeResult<()> {
        basename(&self.name)?; basename(&self.target_name)?;
        if self.dev != self.source.dev || self.dev != self.target.dev { return Err(native_error("EXDEV", "publication cannot cross volumes")); }
        self.source.open()?; self.target.open()?;
        self.file = Some(child(self.source.handle(), &self.name, DELETE | FILE_READ_ATTRIBUTES, 0)?);
        exact(self.file(), self.dev, self.ino)?;
        self.reparse = entry(self.file(), &self.kind)?;
        self.current(false)
    }
    fn current(&mut self, published: bool) -> NativeResult<()> {
        self.source.current()?; self.target.current()?;
        exact(self.file(), self.dev, self.ino)?;
        if entry(self.file(), &self.kind)? != self.reparse { return Err(native_error("path-mismatch", "retained reparse bytes changed")); }
        let (parent, name) = if published { (&self.target, &self.target_name) } else { (&self.source, &self.name) };
        let observed = child(parent.handle(), name, FILE_READ_ATTRIBUTES, 0)?;
        let h = observed.0; self.observations.push(observed); // register before every fallible observation
        exact(h, self.dev, self.ino)?;
        if handle_file_identity(h)? != handle_file_identity(self.file())? || entry(h, &self.kind)? != self.reparse {
            return Err(native_error("path-mismatch", "publication name no longer identifies the retained entry"));
        }
        canonical(h, &format!("{}{}{}", parent.path, if parent.path.ends_with('\\') { "" } else { "\\" }, name))
    }
    fn dispatch(&mut self) -> PublicationReply {
        if let Err(e) = self.current(false) { return reply("not-published", Some(e)); }
        // Windows can permit renaming an entry over its own case alias. Reject
        // any observed occupant; distinct raced entrants remain syscall-fenced.
        match child(self.target.handle(), &self.target_name, FILE_READ_ATTRIBUTES, 0) {
            Ok(h) => { self.observations.push(h); return reply("not-published", Some(native_error("EEXIST", "publication destination exists"))); },
            Err(e) if e.status == "ENOENT" => {},
            Err(e) => return reply("not-published", Some(e)),
        }
        match set_rename_information(self.file(), self.target.handle(), &self.target_name, false, "publish retained entry") {
            Ok(()) => reply("committed", None),
            Err(e) => reply(if matches!(e.status.as_str(), "EEXIST" | "EXDEV" | "ENOTSUP" | "ENOSYS") { "not-published" } else { "indeterminate" }, Some(e)),
        }
    }
    fn close(&mut self) -> Vec<PublicationError> {
        let mut errors = Vec::new();
        let mut close = |h: OwnedHandle| { if let Err(e) = h.close() { errors.push(PublicationError { code: e.status, message: e.reason }); } };
        while let Some(h) = self.observations.pop() { close(h); }
        if let Some(h) = self.file.take() { close(h); }
        while let Some((_, h)) = self.target.chain.pop() { close(h); }
        while let Some((_, h)) = self.source.chain.pop() { close(h); }
        errors
    }
}
#[napi]
pub struct NativeWindowsEntryPublication { owner: Option<Owner>, admission: PublicationReply, transition: Option<PublicationReply>, closes: Option<Vec<PublicationError>> }
#[napi]
impl NativeWindowsEntryPublication {
    #[napi(getter)]
    pub fn admission(&self) -> PublicationReply { self.admission.clone() }
    #[napi]
    pub fn current(&mut self, env: Env, published: bool) -> Result<()> {
        into_napi(env, match self.owner.as_mut() {
            Some(owner) if self.admission.outcome == "retained" => owner.current(published),
            _ => Err(native_error("EINVAL", "publication is not retained")),
        })
    }
    #[napi]
    pub fn publish(&mut self) -> PublicationReply {
        if let Some(result) = &self.transition { return result.clone(); }
        let result = match self.owner.as_mut() {
            Some(owner) if self.admission.outcome == "retained" => owner.dispatch(),
            _ => reply("not-published", Some(native_error("EINVAL", "publication is not retained"))),
        };
        self.transition = Some(result.clone()); result
    }
    #[napi]
    pub fn close(&mut self) -> Vec<PublicationError> {
        if let Some(errors) = &self.closes { return errors.clone(); }
        let errors = self.owner.take().map(|mut owner| owner.close()).unwrap_or_default();
        self.closes = Some(errors.clone()); errors
    }
}
impl Drop for NativeWindowsEntryPublication {
    fn drop(&mut self) { if let Some(mut owner) = self.owner.take() { owner.close(); } }
}
#[napi(js_name = "retainWindowsEntryPublication")]
#[allow(clippy::too_many_arguments)]
pub fn retain_windows_entry_publication(source_path: String, name: String, source_dev: BigInt, source_ino: BigInt,
    target_path: String, target_name: String, target_dev: BigInt, target_ino: BigInt, dev: BigInt, ino: BigInt, kind: String) -> NativeWindowsEntryPublication {
    let mut owner = None;
    let result = (|| -> NativeResult<()> {
        owner = Some(Owner {
            source: Parent { path: source_path, dev: exact_identity_component(&source_dev, "source parent device")?, ino: exact_identity_component(&source_ino, "source parent inode")?, chain: Vec::new() },
            target: Parent { path: target_path, dev: exact_identity_component(&target_dev, "target parent device")?, ino: exact_identity_component(&target_ino, "target parent inode")?, chain: Vec::new() },
            dev: exact_identity_component(&dev, "source device")?, ino: exact_identity_component(&ino, "source inode")?, name, target_name, kind,
            file: None, reparse: Vec::new(), observations: Vec::new(),
        });
        owner.as_mut().unwrap().admit()
    })();
    // Keep even partial ownership until the wrapper explicitly consumes close.
    let admission = match result { Ok(()) => reply("retained", None), Err(e) => reply("not-published", Some(e)) };
    NativeWindowsEntryPublication { owner, admission, transition: None, closes: None }
}

#[cfg(test)]
#[path = "entry_publication_windows_tests.rs"]
mod tests;
