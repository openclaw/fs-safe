use napi::{Env, Result};
use napi_derive::napi;

use crate::into_napi;
#[cfg(not(windows))]
use crate::native_error;

#[napi(object)]
pub struct WindowsAceFlags {
    pub raw: u32,
    pub object_inherit: bool,
    pub container_inherit: bool,
    pub no_propagate_inherit: bool,
    pub inherit_only: bool,
    pub inherited: bool,
    pub successful_access: bool,
    pub failed_access: bool,
}

#[napi(object)]
pub struct WindowsAccessControlEntry {
    pub sid: String,
    pub mask: u32,
    pub ace_type: String,
    pub flags: WindowsAceFlags,
}

#[napi(object)]
pub struct WindowsSecurityFacts {
    pub owner_sid: String,
    pub current_user_sid: String,
    pub owner_class: String,
    pub world_writable: bool,
    pub group_writable: bool,
    pub world_readable: bool,
    pub group_readable: bool,
    pub fallback_required: bool,
    pub dacl_present: bool,
    pub is_local: bool,
    pub ace_list_complete: bool,
    pub unsupported_ace_types: Vec<u32>,
    pub aces: Vec<WindowsAccessControlEntry>,
}

#[cfg(any(windows, test))]
fn ace_flags(raw: u8) -> WindowsAceFlags {
    WindowsAceFlags {
        raw: raw.into(),
        object_inherit: raw & 0x01 != 0,
        container_inherit: raw & 0x02 != 0,
        no_propagate_inherit: raw & 0x04 != 0,
        inherit_only: raw & 0x08 != 0,
        inherited: raw & 0x10 != 0,
        successful_access: raw & 0x40 != 0,
        failed_access: raw & 0x80 != 0,
    }
}

#[napi(js_name = "createPrivateDirectory")]
pub fn create_private_directory(env: Env, path: String) -> Result<()> {
    #[cfg(windows)]
    return into_napi(env, windows::create_private_directory(&path));
    #[cfg(not(windows))]
    {
        let _ = path;
        into_napi(
            env,
            Err(native_error(
                "ENOTSUP",
                "private Windows directories are only available on Windows",
            )),
        )
    }
}

#[napi(js_name = "readOwnerAndDacl")]
pub fn read_owner_and_dacl(env: Env, path: String) -> Result<WindowsSecurityFacts> {
    #[cfg(windows)]
    return into_napi(env, windows::read_owner_and_dacl(&path));
    #[cfg(not(windows))]
    {
        let _ = path;
        into_napi(
            env,
            Err(native_error(
                "ENOTSUP",
                "Windows owner and DACL inspection is only available on Windows",
            )),
        )
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::mem::zeroed;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
        LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, SE_FILE_OBJECT,
        SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACCESS_DENIED_ACE, ACE_HEADER, ACL, CONTAINER_INHERIT_ACE,
        CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, InitializeSecurityDescriptor,
        IsValidSid, IsWellKnownSid, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSID,
        SE_DACL_PRESENT, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
        TOKEN_QUERY, TOKEN_USER, TokenUser, WinAnonymousSid, WinAuthenticatedUserSid,
        WinBuiltinAdministratorsSid, WinBuiltinGuestsSid, WinBuiltinUsersSid, WinInteractiveSid,
        WinLocalSystemSid, WinNetworkSid, WinWorldSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ADD_SUBDIRECTORY, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_OPENED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, GetFinalPathNameByHandleW,
        OPEN_EXISTING, VOLUME_NAME_GUID,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{WindowsAccessControlEntry, WindowsSecurityFacts, ace_flags};
    use crate::{
        NativeResult, native_error,
        windows::{
            HandleFileIdentity, OwnedHandle, handle_attributes, handle_file_identity,
            mark_handle_for_deletion, nt_create_directory_relative,
        },
    };

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const GENERIC_ALL: u32 = 0x1000_0000;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const WRITE_DAC: u32 = 0x0004_0000;
    const WRITE_OWNER: u32 = 0x0008_0000;
    const READ_CONTROL: u32 = 0x0002_0000;
    const FILE_READ_DATA: u32 = 0x0000_0001;
    const FILE_WRITE_DATA: u32 = 0x0000_0002;
    const FILE_APPEND_DATA: u32 = 0x0000_0004;
    const FILE_READ_EA: u32 = 0x0000_0008;
    const FILE_WRITE_EA: u32 = 0x0000_0010;
    const FILE_DELETE_CHILD: u32 = 0x0000_0040;
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
    const PRIVATE_PARENT_CREATE_ACCESS: u32 =
        FILE_READ_ATTRIBUTES | FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE;
    const PRIVATE_PARENT_METADATA_ACCESS: u32 = FILE_READ_ATTRIBUTES;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const INHERIT_ONLY_ACE_FLAG: u8 = 0x08;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
    const FINAL_PATH_STACK_WCHARS: usize = 512;
    const MAX_FINAL_PATH_WCHARS: usize = 32 * 1024;
    const MAX_FINAL_PATH_ATTEMPTS: usize = 4;

    fn wide(value: &str) -> NativeResult<Vec<u16>> {
        if value.encode_utf16().any(|unit| unit == 0) {
            return Err(native_error("EINVAL", "Windows path contains a NUL byte"));
        }
        Ok(std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect())
    }

    fn win_error(code: u32, operation: &str) -> napi::Error<String> {
        let typed = match code {
            5 => "EACCES",
            80 | 183 => "EEXIST",
            2 | 3 => "ENOENT",
            _ => "EIO",
        };
        native_error(
            typed,
            format!("{operation} failed with Windows error {code}"),
        )
    }

    struct TokenSid {
        _buffer: Vec<u8>,
        sid: PSID,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum OwnerClass {
        CurrentUser,
        System,
        Administrators,
        Foreign,
    }

    impl OwnerClass {
        fn as_str(self) -> &'static str {
            match self {
                Self::CurrentUser => "current-user",
                Self::System => "system",
                Self::Administrators => "administrators",
                Self::Foreign => "foreign",
            }
        }
    }

    #[derive(Clone, Copy)]
    struct BasicAce {
        sid: PSID,
        mask: u32,
        ace_type: u8,
        flags: u8,
    }

    #[derive(Clone, Copy, Debug)]
    struct HandleSecurityInspection {
        owner_is_current: bool,
        dacl_protected: bool,
        dacl_present: bool,
        is_local: bool,
        ace_list_complete: bool,
        unsupported_ace_seen: bool,
        untrusted_readable: bool,
        untrusted_writable: bool,
    }

    fn current_user_sid() -> NativeResult<TokenSid> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(win_error(unsafe { GetLastError() }, "open process token"));
        }
        let result = (|| {
            let mut needed = 0_u32;
            unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed) };
            if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
                return Err(win_error(unsafe { GetLastError() }, "size token user"));
            }
            let mut buffer = vec![0_u8; needed as usize];
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    needed,
                    &mut needed,
                )
            } == 0
            {
                return Err(win_error(unsafe { GetLastError() }, "read token user"));
            }
            let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
            Ok(TokenSid {
                _buffer: buffer,
                sid,
            })
        })();
        unsafe { CloseHandle(token) };
        result
    }

    fn well_known_sid(kind: i32) -> NativeResult<Vec<u8>> {
        let mut buffer = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
        let mut size = buffer.len() as u32;
        if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr().cast(), &mut size) }
            == 0
        {
            return Err(win_error(
                unsafe { GetLastError() },
                "create well-known SID",
            ));
        }
        buffer.truncate(size as usize);
        Ok(buffer)
    }

    fn sid_string(sid: PSID) -> NativeResult<String> {
        let mut value = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
            return Err(win_error(unsafe { GetLastError() }, "format SID"));
        }
        let mut length = 0;
        while unsafe { *value.add(length) } != 0 {
            length += 1;
        }
        let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) });
        unsafe { LocalFree(value.cast()) };
        Ok(result.to_ascii_lowercase())
    }

    fn is_world_sid(sid: PSID) -> bool {
        [
            WinWorldSid,
            WinAuthenticatedUserSid,
            WinBuiltinUsersSid,
            WinAnonymousSid,
            WinBuiltinGuestsSid,
            WinInteractiveSid,
            WinNetworkSid,
        ]
        .into_iter()
        .any(|kind| unsafe { IsWellKnownSid(sid, kind) } != 0)
    }

    fn can_read(mask: u32) -> bool {
        mask & (GENERIC_ALL | GENERIC_READ | FILE_READ_DATA | FILE_READ_EA | FILE_READ_ATTRIBUTES)
            != 0
    }

    fn can_write(mask: u32) -> bool {
        mask & (GENERIC_ALL
            | GENERIC_WRITE
            | FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_EA
            | FILE_WRITE_ATTRIBUTES
            | FILE_DELETE_CHILD
            | DELETE_ACCESS
            | WRITE_DAC
            | WRITE_OWNER)
            != 0
    }

    fn parse_basic_ace(
        raw: *mut c_void,
        header: &ACE_HEADER,
    ) -> NativeResult<Option<BasicAce>> {
        let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
        if (header.AceSize as usize) < sid_offset + 8 {
            return Ok(None);
        }
        let (mask, sid) = match header.AceType {
            ACCESS_ALLOWED_ACE_TYPE => {
                let ace = unsafe { &*(raw.cast::<ACCESS_ALLOWED_ACE>()) };
                (
                    ace.Mask,
                    (&ace.SidStart as *const u32).cast_mut().cast::<c_void>(),
                )
            }
            ACCESS_DENIED_ACE_TYPE => {
                let ace = unsafe { &*(raw.cast::<ACCESS_DENIED_ACE>()) };
                (
                    ace.Mask,
                    (&ace.SidStart as *const u32).cast_mut().cast::<c_void>(),
                )
            }
            _ => return Ok(None),
        };
        if unsafe { IsValidSid(sid) } == 0 {
            return Ok(None);
        }
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        if sid_length == 0 || sid_offset + sid_length > header.AceSize as usize {
            return Ok(None);
        }
        Ok(Some(BasicAce {
            sid,
            mask,
            ace_type: header.AceType,
            flags: header.AceFlags,
        }))
    }

    fn public_ace(entry: BasicAce) -> NativeResult<WindowsAccessControlEntry> {
        Ok(WindowsAccessControlEntry {
            sid: sid_string(entry.sid)?,
            mask: entry.mask,
            ace_type: if entry.ace_type == ACCESS_ALLOWED_ACE_TYPE {
                "allow"
            } else {
                "deny"
            }
            .to_owned(),
            flags: ace_flags(entry.flags),
        })
    }

    fn open_security_handle(path: &[u16]) -> NativeResult<OwnedHandle> {
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(win_error(
                unsafe { GetLastError() },
                "open path for locality check",
            ));
        }
        Ok(OwnedHandle(handle))
    }

    fn split_parent(path: &str) -> NativeResult<(PathBuf, String)> {
        if path.encode_utf16().any(|unit| unit == 0) {
            return Err(native_error("EINVAL", "Windows path contains a NUL byte"));
        }
        for component in path.split(['/', '\\']).filter(|component| !component.is_empty()) {
            if component.ends_with([' ', '.']) {
                return Err(native_error(
                    "EINVAL",
                    "private directory path components must not end with a space or period",
                ));
            }
        }
        let target = Path::new(path);
        let name = target
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| native_error("EINVAL", "private directory requires a child name"))?;
        crate::validate_relative_path(name, false)?;
        if name.contains(['/', '\\']) {
            return Err(native_error(
                "EINVAL",
                "private directory requires a direct child name",
            ));
        }
        let parent = target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        Ok((parent.to_path_buf(), name.to_owned()))
    }

    fn open_private_directory_parent(
        path: &Path,
        desired_access: u32,
    ) -> NativeResult<(OwnedHandle, HandleFileIdentity)> {
        let path = path
            .to_str()
            .ok_or_else(|| native_error("EINVAL", "Windows parent path is not valid UTF-8"))?;
        let path = wide(path)?;
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                desired_access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(win_error(
                unsafe { GetLastError() },
                "open private directory parent",
            ));
        }
        let owned = OwnedHandle(handle);
        let attributes = handle_attributes(owned.0)?;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(native_error(
                "ELOOP",
                "private directory parent must not be a reparse point",
            ));
        }
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(native_error(
                "ENOTDIR",
                "private directory parent is not a directory",
            ));
        }
        if !is_local_handle(owned.0)? {
            return Err(native_error(
                "ENOTSUP",
                "private directories require a local filesystem",
            ));
        }
        let identity = handle_file_identity(owned.0)?;
        Ok((owned, identity))
    }

    fn open_private_directory_path(path: &str) -> NativeResult<OwnedHandle> {
        let path = wide(path)?;
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(win_error(
                unsafe { GetLastError() },
                "open private directory through its public path",
            ));
        }
        Ok(OwnedHandle(handle))
    }

    fn final_private_directory_identity<Locality>(
        handle: HANDLE,
        locality: &mut Locality,
    ) -> NativeResult<HandleFileIdentity>
    where
        Locality: FnMut(HANDLE) -> NativeResult<bool>,
    {
        let attributes = handle_attributes(handle)?;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(native_error(
                "ELOOP",
                "created private directory path became a reparse point",
            ));
        }
        if !locality(handle)? {
            return Err(native_error(
                "ENOTSUP",
                "created private directory path must resolve to a local filesystem",
            ));
        }
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(native_error(
                "ENOTDIR",
                "created private directory path no longer names a directory",
            ));
        }
        handle_file_identity(handle)
    }

    fn final_path_with_query<Query>(handle: HANDLE, mut query: Query) -> NativeResult<String>
    where
        Query: FnMut(HANDLE, &mut [u16]) -> NativeResult<usize>,
    {
        let mut stack = [0_u16; FINAL_PATH_STACK_WCHARS];
        let mut heap = Vec::new();
        let mut capacity = FINAL_PATH_STACK_WCHARS;
        for attempt in 0..MAX_FINAL_PATH_ATTEMPTS {
            let buffer: &mut [u16] = if attempt == 0 {
                &mut stack
            } else {
                if capacity > MAX_FINAL_PATH_WCHARS {
                    return Err(native_error("ENAMETOOLONG", "final Windows path is too long"));
                }
                heap.try_reserve_exact(capacity.saturating_sub(heap.len()))
                    .map_err(|_| native_error("ENOMEM", "allocate final Windows path buffer"))?;
                heap.resize(capacity, 0);
                &mut heap
            };
            let written = query(handle, buffer)?;
            if written == 0 {
                return Err(native_error("EIO", "final Windows path query returned zero"));
            }
            if written < buffer.len() {
                return Ok(String::from_utf16_lossy(&buffer[..written]));
            }
            capacity = if written > buffer.len() {
                written
            } else {
                buffer
                    .len()
                    .checked_mul(2)
                    .ok_or_else(|| native_error("ENAMETOOLONG", "final Windows path is too long"))?
            };
            if capacity > MAX_FINAL_PATH_WCHARS {
                return Err(native_error("ENAMETOOLONG", "final Windows path is too long"));
            }
        }
        Err(native_error(
            "EIO",
            "final Windows path changed during bounded retries",
        ))
    }

    fn is_local_handle_with_query<Query>(handle: HANDLE, query: Query) -> NativeResult<bool>
    where
        Query: FnMut(HANDLE, &mut [u16]) -> NativeResult<usize>,
    {
        let final_path = final_path_with_query(handle, query)?;
        Ok(!final_path.starts_with(r"\\?\UNC\")
            && (!final_path.starts_with(r"\\") || final_path.starts_with(r"\\?\")))
    }

    fn is_volume_guid_path(path: &str) -> bool {
        let bytes = path.as_bytes();
        if bytes.len() < 49
            || !bytes[..11].eq_ignore_ascii_case(br"\\?\Volume{")
            || bytes[47] != b'}'
            || bytes[48] != b'\\'
        {
            return false;
        }
        bytes[11..47].iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    }

    fn is_local_handle_with_queries<VolumeGuidQuery, NormalizedDosQuery>(
        handle: HANDLE,
        volume_guid_query: VolumeGuidQuery,
        normalized_dos_query: NormalizedDosQuery,
    ) -> NativeResult<bool>
    where
        VolumeGuidQuery: FnMut(HANDLE, &mut [u16]) -> NativeResult<usize>,
        NormalizedDosQuery: FnMut(HANDLE, &mut [u16]) -> NativeResult<usize>,
    {
        if final_path_with_query(handle, volume_guid_query).is_ok_and(|path| {
            // A volume-GUID path is issued only for a mounted local volume. Do
            // not infer locality from any other successful driver response.
            is_volume_guid_path(&path)
        }) {
            return Ok(true);
        }
        // Network shares have no volume GUID. Keep the normalized DOS query as
        // the fail-closed fallback so UNC paths retain their existing verdict.
        is_local_handle_with_query(handle, normalized_dos_query)
    }

    fn is_local_handle(handle: HANDLE) -> NativeResult<bool> {
        is_local_handle_with_queries(
            handle,
            |handle, buffer| {
                let written = unsafe {
                    GetFinalPathNameByHandleW(
                        handle,
                        buffer.as_mut_ptr(),
                        buffer.len() as u32,
                        FILE_NAME_OPENED | VOLUME_NAME_GUID,
                    )
                };
                if written == 0 {
                    return Err(win_error(
                        unsafe { GetLastError() },
                        "resolve opened volume GUID path",
                    ));
                }
                Ok(written as usize)
            },
            |handle, buffer| {
                let written = unsafe {
                    GetFinalPathNameByHandleW(
                        handle,
                        buffer.as_mut_ptr(),
                        buffer.len() as u32,
                        0,
                    )
                };
                if written == 0 {
                    return Err(win_error(unsafe { GetLastError() }, "resolve final path"));
                }
                Ok(written as usize)
            },
        )
    }

    fn inspect_owner_and_dacl_handle(
        handle: HANDLE,
        current: &TokenSid,
        include_public_report: bool,
    ) -> NativeResult<(HandleSecurityInspection, Option<WindowsSecurityFacts>)> {
        let local = is_local_handle(handle).unwrap_or(false);
        let mut owner = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(win_error(status, "read owner and DACL"));
        }
        let result = (|| {
            if owner.is_null() || unsafe { IsValidSid(owner) } == 0 {
                return Err(native_error(
                    "EIO",
                    "security descriptor owner is absent or invalid",
                ));
            }
            let mut control = 0_u16;
            let mut revision = 0_u32;
            if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            {
                return Err(win_error(
                    unsafe { GetLastError() },
                    "read security descriptor control",
                ));
            }
            let owner_class = if unsafe { EqualSid(owner, current.sid) } != 0 {
                OwnerClass::CurrentUser
            } else if unsafe { IsWellKnownSid(owner, WinLocalSystemSid) } != 0 {
                OwnerClass::System
            } else if unsafe { IsWellKnownSid(owner, WinBuiltinAdministratorsSid) } != 0 {
                OwnerClass::Administrators
            } else {
                OwnerClass::Foreign
            };
            let mut inspection = HandleSecurityInspection {
                owner_is_current: owner_class == OwnerClass::CurrentUser,
                dacl_protected: control & SE_DACL_PROTECTED != 0,
                dacl_present: control & SE_DACL_PRESENT != 0 && !dacl.is_null(),
                is_local: local,
                ace_list_complete: true,
                unsupported_ace_seen: false,
                // An absent or null DACL grants unrestricted access.
                untrusted_readable: dacl.is_null(),
                untrusted_writable: dacl.is_null(),
            };
            // Public reporting and private admission share the same ACE walk.
            // Private admission leaves this absent and compares binary SIDs
            // and masks directly, avoiding report-only SID formatting.
            let mut report = if include_public_report {
                Some(WindowsSecurityFacts {
                    owner_sid: sid_string(owner)?,
                    current_user_sid: sid_string(current.sid)?,
                    owner_class: owner_class.as_str().to_owned(),
                    world_writable: dacl.is_null(),
                    group_writable: false,
                    world_readable: dacl.is_null(),
                    group_readable: false,
                    fallback_required: !local,
                    dacl_present: !dacl.is_null(),
                    is_local: local,
                    ace_list_complete: true,
                    unsupported_ace_types: Vec::new(),
                    aces: Vec::new(),
                })
            } else {
                None
            };
            if !dacl.is_null() {
                let count = unsafe { (*dacl).AceCount } as u32;
                for index in 0..count {
                    let mut raw = null_mut();
                    if unsafe { GetAce(dacl, index, &mut raw) } == 0 || raw.is_null() {
                        inspection.ace_list_complete = false;
                        if let Some(facts) = report.as_mut() {
                            facts.fallback_required = true;
                            facts.ace_list_complete = false;
                        }
                        continue;
                    }
                    let header = unsafe { &*(raw.cast::<ACE_HEADER>()) };
                    let Some(entry) = parse_basic_ace(raw, header)? else {
                        inspection.ace_list_complete = false;
                        inspection.unsupported_ace_seen = true;
                        if let Some(facts) = report.as_mut() {
                            facts.fallback_required = true;
                            facts.ace_list_complete = false;
                            facts.unsupported_ace_types.push(header.AceType.into());
                        }
                        continue;
                    };
                    let mask = entry.mask;
                    if let Some(facts) = report.as_mut() {
                        facts.aces.push(public_ace(entry)?);
                    }
                    if entry.flags & INHERIT_ONLY_ACE_FLAG != 0
                        || entry.ace_type == ACCESS_DENIED_ACE_TYPE
                    {
                        continue;
                    }
                    let trusted = unsafe { EqualSid(entry.sid, current.sid) } != 0
                        || unsafe { IsWellKnownSid(entry.sid, WinLocalSystemSid) } != 0
                        || unsafe { IsWellKnownSid(entry.sid, WinBuiltinAdministratorsSid) } != 0;
                    if trusted {
                        continue;
                    }
                    let readable = can_read(mask);
                    let writable = can_write(mask);
                    inspection.untrusted_readable |= readable;
                    inspection.untrusted_writable |= writable;
                    if let Some(facts) = report.as_mut() {
                        if is_world_sid(entry.sid) {
                            facts.world_readable |= readable;
                            facts.world_writable |= writable;
                        } else {
                            facts.group_readable |= readable;
                            facts.group_writable |= writable;
                        }
                    }
                }
            }
            Ok((inspection, report))
        })();
        unsafe { LocalFree(descriptor) };
        result
    }

    fn read_owner_and_dacl_handle(
        handle: HANDLE,
        current: &TokenSid,
    ) -> NativeResult<HandleSecurityInspection> {
        inspect_owner_and_dacl_handle(handle, current, false)
            .map(|(inspection, _)| inspection)
    }

    fn read_owner_and_dacl_report_handle(
        handle: HANDLE,
        current: &TokenSid,
    ) -> NativeResult<WindowsSecurityFacts> {
        let (_, report) = inspect_owner_and_dacl_handle(handle, current, true)?;
        report.ok_or_else(|| native_error("EIO", "Windows security report was not constructed"))
    }

    pub fn read_owner_and_dacl(path: &str) -> NativeResult<WindowsSecurityFacts> {
        let path = wide(path)?;
        let current = current_user_sid()?;
        let handle = open_security_handle(&path)?;
        read_owner_and_dacl_report_handle(handle.0, &current)
    }

    fn verify_private_directory_association<FinalLocality>(
        path: &str,
        parent_path: &Path,
        parent: &OwnedHandle,
        parent_identity: HandleFileIdentity,
        created_identity: HandleFileIdentity,
        final_locality: &mut FinalLocality,
    ) -> NativeResult<()>
    where
        FinalLocality: FnMut(HANDLE) -> NativeResult<bool>,
    {
        if handle_file_identity(parent.0)? != parent_identity {
            return Err(native_error(
                "EIO",
                "retained private directory parent identity changed",
            ));
        }
        // This public-name reopen only reads attributes, locality, and stable
        // identity; child-creation rights remain confined to the retained parent.
        let (_named_parent, named_parent_identity) =
            open_private_directory_parent(parent_path, PRIVATE_PARENT_METADATA_ACCESS)?;
        if named_parent_identity != parent_identity {
            return Err(native_error(
                "EIO",
                "private directory parent changed during validation",
            ));
        }
        let named = open_private_directory_path(path)?;
        if final_private_directory_identity(named.0, final_locality)? != created_identity {
            return Err(native_error(
                "EIO",
                "private directory named association changed during validation",
            ));
        }
        Ok(())
    }

    fn created_directory_identity(handle: HANDLE) -> NativeResult<HandleFileIdentity> {
        let attributes = handle_attributes(handle)?;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(native_error(
                "ELOOP",
                "created private directory became a reparse point",
            ));
        }
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(native_error(
                "ENOTDIR",
                "created private directory handle is not a directory",
            ));
        }
        handle_file_identity(handle)
    }

    fn validate_private_directory_facts(
        inspection: &HandleSecurityInspection,
    ) -> NativeResult<()> {
        if !inspection.dacl_protected
            || !inspection.owner_is_current
            || !inspection.dacl_present
            || !inspection.is_local
            || !inspection.ace_list_complete
            || inspection.unsupported_ace_seen
            || inspection.untrusted_readable
            || inspection.untrusted_writable
        {
            return Err(native_error(
                "EACCES",
                "filesystem did not enforce the private directory DACL",
            ));
        }
        Ok(())
    }

    fn with_private_directory_cleanup_error(
        error: napi::Error<String>,
        cleanup: NativeResult<()>,
    ) -> napi::Error<String> {
        match cleanup {
            Ok(()) => error,
            Err(cleanup) => native_error(
                error.status,
                format!(
                    "{}; private directory cleanup failed ({}): {}",
                    error.reason, cleanup.status, cleanup.reason
                ),
            ),
        }
    }

    fn create_private_directory_with_hooks<
        AfterCreate,
        QueryCreated,
        AfterValidation,
        Inspect,
        FinalLocality,
    >(
        path: &str,
        mut after_create: AfterCreate,
        mut query_created: QueryCreated,
        mut after_validation: AfterValidation,
        mut inspect: Inspect,
        mut final_locality: FinalLocality,
    ) -> NativeResult<()>
    where
        AfterCreate: FnMut(),
        QueryCreated: FnMut(HANDLE) -> NativeResult<HandleFileIdentity>,
        AfterValidation: FnMut(),
        Inspect: FnMut(HANDLE, &TokenSid) -> NativeResult<HandleSecurityInspection>,
        FinalLocality: FnMut(HANDLE) -> NativeResult<bool>,
    {
        let (parent_path, name) = split_parent(path)?;
        let (parent, parent_identity) =
            open_private_directory_parent(&parent_path, PRIVATE_PARENT_CREATE_ACCESS)?;
        let current = current_user_sid()?;
        let system = well_known_sid(WinLocalSystemSid)?;
        let administrators = well_known_sid(WinBuiltinAdministratorsSid)?;
        let sids: [PSID; 3] = [
            current.sid,
            system.as_ptr().cast_mut().cast(),
            administrators.as_ptr().cast_mut().cast(),
        ];
        let mut entries: [EXPLICIT_ACCESS_W; 3] = unsafe { zeroed() };
        for (entry, sid) in entries.iter_mut().zip(sids) {
            entry.grfAccessPermissions = FILE_ALL_ACCESS;
            entry.grfAccessMode = GRANT_ACCESS;
            entry.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            entry.Trustee.ptstrName = sid.cast();
        }
        let mut acl: *mut ACL = null_mut();
        let status =
            unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), null(), &mut acl) };
        if status != 0 {
            return Err(win_error(status, "build private directory DACL"));
        }
        let result = (|| {
            let mut descriptor: SECURITY_DESCRIPTOR = unsafe { zeroed() };
            let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
            if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) }
                == 0
                || unsafe { SetSecurityDescriptorOwner(descriptor_ptr, current.sid, 0) } == 0
                || unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl, 0) } == 0
                || unsafe {
                    SetSecurityDescriptorControl(
                        descriptor_ptr,
                        SE_DACL_PROTECTED,
                        SE_DACL_PROTECTED,
                    )
                } == 0
            {
                return Err(win_error(
                    unsafe { GetLastError() },
                    "build private directory security descriptor",
                ));
            }
            let created =
                nt_create_directory_relative(parent.0, &name, descriptor_ptr).map_err(|error| {
                    if error.status == "EPERM" {
                        native_error("EACCES", error.reason)
                    } else {
                        error
                    }
                })?;
            let operation = (|| {
                after_create();
                let created_identity = query_created(created.0)?;
                let inspection = inspect(created.0, &current)?;
                validate_private_directory_facts(&inspection)?;
                after_validation();
                verify_private_directory_association(
                    path,
                    &parent_path,
                    &parent,
                    parent_identity,
                    created_identity,
                    &mut final_locality,
                )
            })();
            operation.map_err(|error| {
                with_private_directory_cleanup_error(error, mark_handle_for_deletion(created.0))
            })
        })();
        unsafe { LocalFree(acl.cast()) };
        result
    }

    pub fn create_private_directory(path: &str) -> NativeResult<()> {
        create_private_directory_with_hooks(
            path,
            || {},
            created_directory_identity,
            || {},
            read_owner_and_dacl_handle,
            is_local_handle,
        )
    }

    #[cfg(test)]
    mod tests {
        use std::cell::Cell;
        use std::fs::{self, OpenOptions};
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use std::path::{Path, PathBuf};
        use std::time::{SystemTime, UNIX_EPOCH};

        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        use super::*;

        fn temp_root(label: &str) -> PathBuf {
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = base.join(format!(
                "fs-safe-private-directory-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            root
        }

        fn ordinary_win32_path(path: &Path) -> PathBuf {
            let path = path.to_str().unwrap();
            if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
                PathBuf::from(format!(r"\\{path}"))
            } else if let Some(path) = path.strip_prefix(r"\\?\") {
                PathBuf::from(path)
            } else {
                PathBuf::from(path)
            }
        }

        fn path_identity(path: &Path) -> HandleFileIdentity {
            let handle = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .unwrap();
            handle_file_identity(handle.as_raw_handle() as HANDLE).unwrap()
        }

        fn replace_directory(target: &Path, original: &Path) -> HandleFileIdentity {
            fs::rename(target, original).unwrap();
            fs::create_dir(target).unwrap();
            fs::write(target.join("keep"), b"replacement").unwrap();
            path_identity(target)
        }

        fn write_final_path_result(path: &str, buffer: &mut [u16]) -> usize {
            let units = path.encode_utf16().collect::<Vec<_>>();
            let required = units.len() + 1;
            if buffer.len() < required {
                return required;
            }
            buffer[..units.len()].copy_from_slice(&units);
            buffer[units.len()] = 0;
            units.len()
        }

        fn valid_private_inspection() -> HandleSecurityInspection {
            HandleSecurityInspection {
                owner_is_current: true,
                dacl_protected: true,
                dacl_present: true,
                is_local: true,
                ace_list_complete: true,
                unsupported_ace_seen: false,
                untrusted_readable: false,
                untrusted_writable: false,
            }
        }

        #[test]
        fn final_path_query_uses_stack_and_bounded_fallbacks() {
            let handle = null_mut();
            let short = r"\\?\C:\short";
            let mut capacities = Vec::new();
            assert!(
                is_local_handle_with_query(handle, |_, buffer| {
                    capacities.push(buffer.len());
                    Ok(write_final_path_result(short, buffer))
                })
                .unwrap()
            );
            assert_eq!(capacities, [FINAL_PATH_STACK_WCHARS]);
            for (path, expected) in [
                (r"\\?\UNC\server\share\private", false),
                (r"\\server\share\private", false),
                (r"\\?\C:\private", true),
            ] {
                assert_eq!(
                    is_local_handle_with_query(handle, |_, buffer| {
                        Ok(write_final_path_result(path, buffer))
                    })
                    .unwrap(),
                    expected
                );
            }

            let long = format!(r"\\?\C:\{}", "a".repeat(FINAL_PATH_STACK_WCHARS));
            capacities.clear();
            assert!(
                is_local_handle_with_query(handle, |_, buffer| {
                    capacities.push(buffer.len());
                    Ok(write_final_path_result(&long, buffer))
                })
                .unwrap()
            );
            assert_eq!(
                capacities,
                [FINAL_PATH_STACK_WCHARS, long.encode_utf16().count() + 1]
            );

            let prefix = r"\\?\C:\";
            let boundary = format!(
                "{prefix}{}",
                "a".repeat(MAX_FINAL_PATH_WCHARS - 1 - prefix.encode_utf16().count())
            );
            capacities.clear();
            assert!(
                is_local_handle_with_query(handle, |_, buffer| {
                    capacities.push(buffer.len());
                    Ok(write_final_path_result(&boundary, buffer))
                })
                .unwrap()
            );
            assert_eq!(capacities, [FINAL_PATH_STACK_WCHARS, MAX_FINAL_PATH_WCHARS]);

            let too_long = final_path_with_query(handle, |_, _| {
                Ok(MAX_FINAL_PATH_WCHARS + 1)
            })
            .unwrap_err();
            assert_eq!(too_long.status, "ENAMETOOLONG");
            assert_eq!(too_long.reason, "final Windows path is too long");

            let zero = final_path_with_query(handle, |_, _| Ok(0)).unwrap_err();
            assert_eq!(zero.status, "EIO");
            assert_eq!(zero.reason, "final Windows path query returned zero");
        }

        #[test]
        fn volume_guid_fast_path_accepts_only_a_canonical_local_volume() {
            let handle = null_mut();
            let volume_guid = r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\private";
            assert!(is_volume_guid_path(volume_guid));
            assert!(is_volume_guid_path(
                r"\\?\VOLUME{ABCDEF01-2345-6789-ABCD-EF0123456789}\private"
            ));
            for path in [
                r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdeg}\private",
                r"\\?\Volume{0123456789ab-cdef-0123-456789abcdef}\private",
                r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}/private",
                r"\\?\UNC\server\share\private",
                r"\\?\C:\private",
            ] {
                assert!(!is_volume_guid_path(path), "accepted {path}");
            }

            let fallback_calls = Cell::new(0);
            assert!(
                is_local_handle_with_queries(
                    handle,
                    |_, buffer| Ok(write_final_path_result(volume_guid, buffer)),
                    |_, _| -> NativeResult<usize> {
                        panic!("a valid volume GUID must not query the DOS fallback")
                    },
                )
                .unwrap()
            );
            assert!(
                !is_local_handle_with_queries(
                    handle,
                    |_, buffer| {
                        Ok(write_final_path_result(
                            r"\\?\Volume{not-a-volume-guid}\private",
                            buffer,
                        ))
                    },
                    |_, buffer| {
                        fallback_calls.set(fallback_calls.get() + 1);
                        Ok(write_final_path_result(
                            r"\\?\UNC\server\share\private",
                            buffer,
                        ))
                    },
                )
                .unwrap()
            );
            assert_eq!(fallback_calls.get(), 1);

            assert!(
                is_local_handle_with_queries(
                    handle,
                    |_, _| Err(native_error("EIO", "volume GUID unavailable")),
                    |_, buffer| Ok(write_final_path_result(r"\\?\C:\private", buffer)),
                )
                .unwrap()
            );
        }

        #[test]
        fn private_validation_fails_closed_for_every_raw_predicate() {
            let valid = valid_private_inspection();
            validate_private_directory_facts(&valid).unwrap();

            let failures = [
                HandleSecurityInspection {
                    dacl_protected: false,
                    ..valid
                },
                HandleSecurityInspection {
                    owner_is_current: false,
                    ..valid
                },
                HandleSecurityInspection {
                    dacl_present: false,
                    ..valid
                },
                HandleSecurityInspection {
                    is_local: false,
                    ..valid
                },
                HandleSecurityInspection {
                    ace_list_complete: false,
                    ..valid
                },
                HandleSecurityInspection {
                    unsupported_ace_seen: true,
                    ..valid
                },
                HandleSecurityInspection {
                    untrusted_readable: true,
                    ..valid
                },
                HandleSecurityInspection {
                    untrusted_writable: true,
                    ..valid
                },
            ];
            for inspection in failures {
                let error = validate_private_directory_facts(&inspection).unwrap_err();
                assert_eq!(error.status, "EACCES");
                assert_eq!(
                    error.reason,
                    "filesystem did not enforce the private directory DACL"
                );
            }
        }

        #[test]
        fn creates_private_directory_with_validated_dacl() {
            let root = temp_root("success");
            let target = root.join("private");
            let private_inspection = Cell::new(None);
            create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || {},
                created_directory_identity,
                || {},
                |handle, current| {
                    let inspection = read_owner_and_dacl_handle(handle, current)?;
                    private_inspection.set(Some(inspection));
                    Ok(inspection)
                },
                is_local_handle,
            )
            .unwrap();

            let facts = read_owner_and_dacl(target.to_str().unwrap()).unwrap();
            let inspection = private_inspection.get().unwrap();
            assert!(inspection.dacl_protected);
            assert_eq!(inspection.owner_is_current, facts.owner_class == "current-user");
            assert_eq!(inspection.dacl_present, facts.dacl_present);
            assert_eq!(inspection.is_local, facts.is_local);
            assert_eq!(inspection.ace_list_complete, facts.ace_list_complete);
            assert_eq!(
                inspection.unsupported_ace_seen,
                !facts.unsupported_ace_types.is_empty()
            );
            assert_eq!(
                inspection.untrusted_readable,
                facts.world_readable || facts.group_readable
            );
            assert_eq!(
                inspection.untrusted_writable,
                facts.world_writable || facts.group_writable
            );
            assert_eq!(facts.owner_class, "current-user");
            assert_eq!(facts.owner_sid, facts.current_user_sid);
            assert!(facts.dacl_present);
            assert!(facts.is_local);
            assert!(facts.ace_list_complete);
            assert!(!facts.fallback_required);
            assert!(!facts.world_readable);
            assert!(!facts.world_writable);
            assert!(!facts.group_readable);
            assert!(!facts.group_writable);
            assert_eq!(facts.aces.len(), 3);

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn rejects_an_unprotected_created_directory_and_cleans_its_handle() {
            let root = temp_root("unprotected-dacl");
            let target = root.join("private");

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || {},
                created_directory_identity,
                || panic!("unprotected DACL must stop before final validation"),
                |handle, current| {
                    let mut inspection = read_owner_and_dacl_handle(handle, current)?;
                    assert!(inspection.dacl_protected);
                    inspection.dacl_protected = false;
                    Ok(inspection)
                },
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "EACCES");
            assert_eq!(
                error.reason,
                "filesystem did not enforce the private directory DACL"
            );
            assert!(!target.try_exists().unwrap());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn collision_preserves_the_existing_directory() {
            let root = temp_root("collision");
            let target = root.join("private");
            fs::create_dir(&target).unwrap();
            fs::write(target.join("keep"), b"existing").unwrap();
            let identity = path_identity(&target);

            let error = create_private_directory(target.to_str().unwrap()).unwrap_err();
            assert_eq!(error.status, "EEXIST");
            assert_eq!(path_identity(&target), identity);
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"existing");

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn rejects_ambiguous_trailing_leaf_forms_before_creation() {
            let root = temp_root("ambiguous-leaf");
            for name in ["private.", "private "] {
                let target = root.join(name);
                let error = create_private_directory(target.to_str().unwrap()).unwrap_err();
                assert_eq!(error.status, "EINVAL");
                assert!(fs::read_dir(&root).unwrap().next().is_none());
            }

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn rejects_dot_and_ambiguous_parent_components_before_creation() {
            let root = temp_root("ambiguous-components");
            for component in [".", "..", "parent.", "parent "] {
                let target = format!(r"{}\{}\private", root.display(), component);
                let error = create_private_directory(&target).unwrap_err();
                assert_eq!(error.status, "EINVAL");
                assert!(fs::read_dir(&root).unwrap().next().is_none());
            }

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn ambiguous_normalized_collision_preserves_the_existing_directory() {
            let root = temp_root("normalized-collision");
            let existing = root.join("private");
            fs::create_dir(&existing).unwrap();
            fs::write(existing.join("keep"), b"existing").unwrap();
            let identity = path_identity(&existing);

            for name in ["private.", "private "] {
                let error =
                    create_private_directory(root.join(name).to_str().unwrap()).unwrap_err();
                assert_eq!(error.status, "EINVAL");
                assert_eq!(path_identity(&existing), identity);
                assert_eq!(fs::read(existing.join("keep")).unwrap(), b"existing");
            }

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn ordinary_win32_parent_alias_does_not_touch_its_normalized_collision() {
            let canonical_root = temp_root("parent-alias");
            let root = ordinary_win32_path(&canonical_root);
            assert!(!root.to_str().unwrap().starts_with(r"\\?\"));
            let parent = root.join("parent");
            let collision = parent.join("private");
            fs::create_dir(&parent).unwrap();
            fs::create_dir(&collision).unwrap();
            fs::write(collision.join("keep"), b"existing").unwrap();
            let parent_identity = path_identity(&parent);
            let collision_identity = path_identity(&collision);

            let target = root.join("parent.").join("private");
            let error = create_private_directory(target.to_str().unwrap()).unwrap_err();
            assert_eq!(error.status, "EINVAL");
            assert_eq!(path_identity(&parent), parent_identity);
            assert_eq!(path_identity(&collision), collision_identity);
            assert_eq!(fs::read(collision.join("keep")).unwrap(), b"existing");
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);

            fs::remove_dir_all(canonical_root).unwrap();
        }

        #[test]
        fn substitution_before_validation_preserves_the_exact_replacement() {
            let root = temp_root("before-validation");
            let target = root.join("private");
            let original = root.join("original");
            let mut replacement = None;
            let created_handle = Cell::new(null_mut());

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || replacement = Some(replace_directory(&target, &original)),
                |handle| {
                    created_handle.set(handle);
                    created_directory_identity(handle)
                },
                || {},
                |handle, current| {
                    assert_eq!(handle, created_handle.get());
                    read_owner_and_dacl_handle(handle, current)
                },
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "EIO");
            assert_eq!(path_identity(&target), replacement.unwrap());
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"replacement");
            assert!(!original.try_exists().unwrap());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn substitution_after_validation_preserves_the_exact_replacement() {
            let root = temp_root("after-validation");
            let target = root.join("private");
            let original = root.join("original");
            let mut replacement = None;

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || {},
                created_directory_identity,
                || replacement = Some(replace_directory(&target, &original)),
                read_owner_and_dacl_handle,
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "EIO");
            assert_eq!(path_identity(&target), replacement.unwrap());
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"replacement");
            assert!(!original.exists());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn substitution_after_validation_preserves_an_empty_replacement() {
            let root = temp_root("empty-replacement");
            let target = root.join("private");
            let original = root.join("original");
            let mut replacement = None;

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || {},
                created_directory_identity,
                || {
                    fs::rename(&target, &original).unwrap();
                    fs::create_dir(&target).unwrap();
                    replacement = Some(path_identity(&target));
                },
                read_owner_and_dacl_handle,
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "EIO");
            assert_eq!(path_identity(&target), replacement.unwrap());
            assert!(fs::read_dir(&target).unwrap().next().is_none());
            assert!(!original.try_exists().unwrap());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn parent_substitution_is_detected_without_deleting_its_child() {
            let root = temp_root("parent-substitution");
            let parent = root.join("parent");
            let original_parent = root.join("original-parent");
            let target = parent.join("private");
            let moved_created = root.join("moved-created");
            fs::create_dir(&parent).unwrap();
            let original_parent_identity = path_identity(&parent);
            let mut replacement_parent = None;
            let mut replacement_child = None;

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || {},
                created_directory_identity,
                || {
                    fs::rename(&target, &moved_created).unwrap();
                    fs::rename(&parent, &original_parent).unwrap();
                    fs::create_dir(&parent).unwrap();
                    fs::create_dir(&target).unwrap();
                    fs::write(target.join("keep"), b"replacement").unwrap();
                    replacement_parent = Some(path_identity(&parent));
                    replacement_child = Some(path_identity(&target));
                },
                read_owner_and_dacl_handle,
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "EIO");
            assert_eq!(
                error.reason,
                "private directory parent changed during validation"
            );
            assert_eq!(path_identity(&original_parent), original_parent_identity);
            assert_eq!(path_identity(&parent), replacement_parent.unwrap());
            assert_eq!(path_identity(&target), replacement_child.unwrap());
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"replacement");
            assert!(!moved_created.try_exists().unwrap());
            assert!(!original_parent.join("private").try_exists().unwrap());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn inspection_failure_preserves_a_substituted_directory() {
            let root = temp_root("inspection-failure");
            let target = root.join("private");
            let original = root.join("original");
            let mut replacement = None;

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || replacement = Some(replace_directory(&target, &original)),
                created_directory_identity,
                || panic!("failed inspection must stop before final validation"),
                |_, _| {
                    Err(native_error(
                        "inspection-failed",
                        "injected inspection failure",
                    ))
                },
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "inspection-failed");
            assert_eq!(error.reason, "injected inspection failure");
            assert_eq!(path_identity(&target), replacement.unwrap());
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"replacement");
            assert!(!original.exists());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn stable_created_identity_query_failure_preserves_a_substitution() {
            let root = temp_root("stable-identity-query-failure");
            let target = root.join("private");
            let original = root.join("original");
            let mut replacement = None;

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || replacement = Some(replace_directory(&target, &original)),
                |_| {
                    Err(native_error(
                        "ENOTSUP",
                        "stable 128-bit Windows file identity is unavailable (injected)",
                    ))
                },
                || panic!("failed identity query must stop before validation"),
                |_, _| panic!("failed identity query must stop before ACL inspection"),
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "ENOTSUP");
            assert_eq!(
                error.reason,
                "stable 128-bit Windows file identity is unavailable (injected)"
            );
            assert_eq!(path_identity(&target), replacement.unwrap());
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"replacement");
            assert!(!original.exists());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn final_handle_long_path_failure_preserves_a_substitution() {
            let root = temp_root("final-long-path-failure");
            let target = root.join("private");
            let original = root.join("original");
            let mut replacement = None;
            let mut locality_queried = false;

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || {},
                created_directory_identity,
                || replacement = Some(replace_directory(&target, &original)),
                read_owner_and_dacl_handle,
                |handle| {
                    locality_queried = true;
                    is_local_handle_with_query(handle, |_, _| Ok(MAX_FINAL_PATH_WCHARS + 1))
                },
            )
            .unwrap_err();
            assert_eq!(error.status, "ENAMETOOLONG");
            assert_eq!(error.reason, "final Windows path is too long");
            assert!(locality_queried);
            assert_eq!(path_identity(&target), replacement.unwrap());
            assert_eq!(fs::read(target.join("keep")).unwrap(), b"replacement");
            assert!(!original.try_exists().unwrap());

            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn inspection_and_cleanup_failures_are_both_reported() {
            let root = temp_root("cleanup-failure");
            let target = root.join("private");

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                || fs::write(target.join("blocker"), b"keep").unwrap(),
                created_directory_identity,
                || panic!("failed inspection must stop before final validation"),
                |_, _| {
                    Err(native_error(
                        "inspection-failed",
                        "injected inspection failure",
                    ))
                },
                is_local_handle,
            )
            .unwrap_err();
            assert_eq!(error.status, "inspection-failed");
            assert!(error.reason.starts_with("injected inspection failure;"));
            assert!(
                error
                    .reason
                    .contains("private directory cleanup failed (EIO):")
            );
            assert_eq!(fs::read(target.join("blocker")).unwrap(), b"keep");

            fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ace_flags;

    #[test]
    fn decodes_ace_inheritance_and_audit_flags() {
        let flags = ace_flags(0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x40 | 0x80);
        assert!(flags.object_inherit);
        assert!(flags.container_inherit);
        assert!(flags.no_propagate_inherit);
        assert!(flags.inherit_only);
        assert!(flags.inherited);
        assert!(flags.successful_access);
        assert!(flags.failed_access);
    }
}
