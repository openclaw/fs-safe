use super::{Directory, Notify, Pending, SharedPending};
use crate::windows::{
    OwnedHandle, handle_identity_and_size, handle_is_reparse, open_existing_handle, win_error,
};
use crate::{ExactFileIdentity, NativeResult, native_error};
use std::collections::HashMap;
use std::mem::{replace, zeroed};
use std::ptr::null_mut;
use std::sync::Arc;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND, ERROR_NOTIFY_ENUM_DIR,
    ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, GetLastError, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::IO::{
    CancelIoEx, CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED, PostQueuedCompletionStatus,
};

const CAPACITY: usize = 65536;
struct Anchor {
    owner: u32,
    identity: ExactFileIdentity,
    handle: OwnedHandle,
    overlapped: OVERLAPPED,
    buffer: Vec<u32>,
    pending: SharedPending,
    armed: bool,
    retiring: bool,
}
impl Anchor {
    fn arm(&mut self) -> NativeResult<()> {
        self.overlapped = unsafe { zeroed() };
        // The box, DWORD-aligned buffer, and OVERLAPPED stay live until IOCP completion.
        let ok = unsafe {
            ReadDirectoryChangesW(
                self.handle.0,
                self.buffer.as_mut_ptr().cast(),
                CAPACITY as u32,
                1,
                FILE_NOTIFY_CHANGE_FILE_NAME
                    | FILE_NOTIFY_CHANGE_DIR_NAME
                    | FILE_NOTIFY_CHANGE_ATTRIBUTES
                    | FILE_NOTIFY_CHANGE_SIZE
                    | FILE_NOTIFY_CHANGE_LAST_WRITE
                    | FILE_NOTIFY_CHANGE_CREATION
                    | FILE_NOTIFY_CHANGE_SECURITY,
                null_mut(),
                &mut self.overlapped,
                None,
            )
        };
        if ok == 0 {
            return Err(read_error(unsafe { GetLastError() }));
        }
        self.armed = true;
        Ok(())
    }
    fn fail(&self, error: napi::Error<String>) {
        let mut pending = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.overflow();
        pending.error = Some(error.status);
    }
    fn close(mut self) -> NativeResult<()> {
        debug_assert!(!self.armed);
        let handle = replace(&mut self.handle.0, null_mut());
        if unsafe { CloseHandle(handle) } == 0 {
            return Err(win_error(unsafe { GetLastError() }, "close directory changes"));
        }
        Ok(())
    }
}
// Completion-port handles may be posted from any thread. Arc keeps the handle
// live through queued JS acknowledgements, including after the hub has joined.
struct Port(OwnedHandle);
unsafe impl Send for Port {}
unsafe impl Sync for Port {}
#[derive(Clone)]
pub(super) struct Waker(Arc<Port>);
impl Waker {
    pub fn wake(&self) {
        unsafe {
            PostQueuedCompletionStatus(self.0.0.0, 0, 0, null_mut());
        }
    }
}
pub(super) struct Backend {
    port: Arc<Port>,
    owners: HashMap<u32, SharedPending>,
    anchors: HashMap<usize, Box<Anchor>>,
    next: usize,
}
fn read_error(code: u32) -> napi::Error<String> {
    if [ERROR_NOTIFY_ENUM_DIR, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND]
        .contains(&code)
    {
        native_error("ESTALE", "watch anchor needs guarded reconciliation")
    } else {
        win_error(code, "read directory changes")
    }
}
fn check(handle: &OwnedHandle, expected: ExactFileIdentity) -> NativeResult<()> {
    let ((dev, ino, directory), _) = handle_identity_and_size(handle.0)?;
    if !directory || handle_is_reparse(handle.0)? || u64::from(dev) != expected.dev || ino != expected.ino {
        return Err(native_error("ESTALE", "watch directory identity changed"));
    }
    Ok(())
}
fn open_root(root: &str, identity: ExactFileIdentity) -> NativeResult<OwnedHandle> {
    crate::validate_windows_filesystem_path(root)?;
    if root.contains('\0') {
        return Err(native_error("EINVAL", "invalid watch root"));
    }
    let root: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
    let root = open_existing_handle(
        &root,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED,
        |code| win_error(code, "open watch root"),
    )?;
    check(&root, identity)?;
    Ok(root)
}
fn decode(pending: &mut Pending, bytes: &[u8]) {
    let mut at = 0;
    loop {
        if at + 12 > bytes.len() {
            pending.overflow();
            return;
        }
        let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let next = word(at);
        let action = word(at + 4);
        let length = word(at + 8);
        let Some(name) = bytes.get(at + 12..at + 12 + length).filter(|_| length > 0 && length % 2 == 0)
        else {
            pending.overflow();
            return;
        };
        let name: Vec<u16> =
            name.chunks_exact(2).map(|word| u16::from_le_bytes([word[0], word[1]])).collect();
        let Ok(name) = String::from_utf16(&name) else {
            pending.overflow();
            return;
        };
        if !(1..=5).contains(&action)
            || name.contains(['\0', ':', '/'])
            || name.split('\\').any(|part| part.is_empty() || part == "." || part == "..")
        {
            pending.overflow();
            return;
        }
        let (parent, leaf) = name.rsplit_once('\\').unwrap_or(("", &name));
        pending.push(parent.into(), leaf.into(), action != FILE_ACTION_MODIFIED as usize);
        if next == 0 {
            return;
        }
        if next < 12 + length || next % 4 != 0 || next > bytes.len() - at {
            pending.overflow();
            return;
        }
        at += next;
    }
}
impl Backend {
    pub fn new() -> NativeResult<Self> {
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) };
        if port.is_null() {
            return Err(win_error(unsafe { GetLastError() }, "create watch completion port"));
        }
        Ok(Self {
            port: Arc::new(Port(OwnedHandle(port))),
            owners: HashMap::new(),
            anchors: HashMap::new(),
            next: 1,
        })
    }
    pub fn register(&mut self, id: u32, _: &str, pending: SharedPending, _: Notify) -> NativeResult<()> {
        self.owners.insert(id, pending);
        Ok(())
    }
    pub fn add(&mut self, id: u32, directory: &Directory) -> NativeResult<()> {
        let pending =
            self.owners.get(&id).ok_or_else(|| native_error("EINVAL", "unknown watch registration"))?.clone();
        if let Some(anchor) = self.anchors.values().find(|anchor| anchor.owner == id) {
            if anchor.identity != directory.root_identity {
                return Err(native_error("ESTALE", "watch Root identity changed"));
            }
            return Ok(());
        }
        // Retaining descendant directory handles blocks renaming their ancestors
        // on Windows, even with DELETE sharing. Scope filtering stays in guarded JS scans.
        let handle = open_root(&directory.root, directory.root_identity)?;
        let key = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| native_error("EOVERFLOW", "watch anchor identifiers exhausted"))?;
        let mut anchor = Box::new(Anchor {
            owner: id,
            identity: directory.root_identity,
            handle,
            overlapped: unsafe { zeroed() },
            buffer: vec![0; CAPACITY / 4],
            pending,
            armed: false,
            retiring: false,
        });
        if unsafe { CreateIoCompletionPort(anchor.handle.0, self.port.0.0, key, 0) }.is_null() {
            return Err(win_error(unsafe { GetLastError() }, "associate watch completion port"));
        }
        anchor.arm()?;
        self.anchors.insert(key, anchor);
        Ok(())
    }
    fn completion(&mut self, timeout: u32) -> bool {
        let (mut bytes, mut key, mut overlapped) = (0, 0, null_mut());
        let ok = unsafe {
            GetQueuedCompletionStatus(self.port.0.0, &mut bytes, &mut key, &mut overlapped, timeout)
        };
        let code = if ok != 0 { ERROR_SUCCESS } else { unsafe { GetLastError() } };
        if overlapped.is_null() {
            if ok != 0 && key == 0 {
                return true;
            } // Command wake, never an anchor completion.
            if code != WAIT_TIMEOUT {
                for pending in self.owners.values() {
                    pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).error =
                        Some(win_error(code, "dequeue watch completion").status);
                }
            }
            return false;
        }
        let Some(anchor) = self.anchors.get_mut(&key) else {
            return true;
        };
        debug_assert_eq!(overlapped, &mut anchor.overlapped as *mut _);
        anchor.armed = false;
        if anchor.retiring {
            return true;
        }
        if code != ERROR_SUCCESS && code != ERROR_NOTIFY_ENUM_DIR {
            anchor.fail(read_error(code));
            return true;
        }
        let count = bytes as usize;
        // Copy completed bytes, then re-arm before examining names or scheduling a JS scan.
        let data = if code == ERROR_SUCCESS && (1..=CAPACITY).contains(&count) {
            unsafe { std::slice::from_raw_parts(anchor.buffer.as_ptr().cast::<u8>(), count) }.to_vec()
        } else {
            Vec::new()
        };
        if let Err(error) = anchor.arm() {
            anchor.fail(error);
            return true;
        }
        let mut pending = anchor.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if data.is_empty() {
            pending.overflow();
        } else {
            decode(&mut pending, &data);
        }
        true
    }
    fn retire(&mut self, keys: &[usize]) -> NativeResult<()> {
        let mut failure = None;
        for key in keys {
            let anchor = self.anchors.get_mut(key).unwrap();
            anchor.retiring = true;
            if anchor.armed && unsafe { CancelIoEx(anchor.handle.0, &anchor.overlapped) } == 0 {
                let code = unsafe { GetLastError() };
                // NOT_FOUND also covers an already queued completion: it still must be consumed.
                if code != ERROR_NOT_FOUND {
                    failure.get_or_insert_with(|| win_error(code, "cancel directory changes"));
                }
            }
        }
        while keys.iter().any(|key| self.anchors[key].armed) {
            self.completion(u32::MAX);
        }
        for key in keys {
            if let Err(error) = self.anchors.remove(key).unwrap().close() {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn remove(&mut self, id: u32) -> NativeResult<()> {
        let keys: Vec<_> = self.anchors.iter().filter(|(_, a)| a.owner == id).map(|(&key, _)| key).collect();
        let result = self.retire(&keys);
        self.owners.remove(&id);
        result
    }
    pub fn waker(&self) -> Waker {
        Waker(self.port.clone())
    }
    pub fn wait(&mut self) {
        self.completion(u32::MAX);
        for _ in 1..256 {
            if !self.completion(0) {
                break;
            }
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let keys = self.anchors.keys().copied().collect::<Vec<_>>();
        let _ = self.retire(&keys);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn immediate_enumeration_loss_rebuilds_instead_of_disabling_observation() {
        assert_eq!(read_error(ERROR_NOTIFY_ENUM_DIR).status, "ESTALE");
        assert_eq!(read_error(ERROR_ACCESS_DENIED).status, "ESTALE");
        assert_ne!(read_error(87).status, "ESTALE"); // Invalid parameter is a transport failure.
    }
    #[test]
    fn malformed_and_empty_completions_lose_detail() {
        let mut pending = Pending { limit: 2, ..Pending::default() };
        for bytes in [&[][..], &[0; 12][..], &[255; 20][..]] {
            decode(&mut pending, bytes);
            assert!(pending.take().unwrap().overflow);
        }
    }
}
