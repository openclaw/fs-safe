use napi::{Env, Result};
use napi_derive::napi;

#[cfg(windows)]
use crate::NativeResult;
use crate::into_napi;
#[cfg(not(windows))]
use crate::native_error;
#[cfg(windows)]
use crate::validate_windows_filesystem_path;

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

#[napi(object)]
#[derive(Debug)]
pub struct WindowsIdentityReceipt {
    pub identity: String,
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

macro_rules! windows_security_export {
    (@unused $arg:ident: $arg_type:ty $(,)?) => {
        $arg
    };
    (@unused $($arg:ident: $arg_type:ty),+ $(,)?) => {
        ($($arg),+)
    };
    (
        $js_name:literal,
        fn $name:ident($env:ident: Env, $($args:tt)*) -> $result:ty,
        $operation:expr,
        $unsupported:literal
    ) => {
        #[napi(js_name = $js_name)]
        pub fn $name($env: Env, $($args)*) -> Result<$result> {
            #[cfg(windows)]
            return into_napi(
                $env,
                $operation,
            );
            #[cfg(not(windows))]
            {
                let _ = $crate::windows_security::windows_security_export!(@unused $($args)*);
                into_napi(
                    $env,
                    Err(native_error(
                        "ENOTSUP",
                        $unsupported,
                    )),
                )
            }
        }
    };
}

pub(crate) use windows_security_export;

windows_security_export!(
    "createPrivateDirectory",
    fn create_private_directory(env: Env, path: String) -> (),
    validate_windows_filesystem_path(&path)
        .and_then(|()| windows::create_private_directory(&path)),
    "private Windows directories are only available on Windows"
);

windows_security_export!(
    "inspectWindowsDirectory",
    fn inspect_windows_directory(
        env: Env,
        path: String,
        require_private: bool,
    ) -> WindowsIdentityReceipt,
    validate_windows_filesystem_path(&path)
        .and_then(|()| windows::inspect_directory(&path, require_private)),
    "Windows directory inspection is only available on Windows"
);

windows_security_export!(
    "createPrivateDirectoryWithParentIdentity",
    fn create_private_directory_with_parent_identity(
        env: Env,
        path: String,
        expected_parent_identity: String,
    ) -> WindowsIdentityReceipt,
    validate_windows_filesystem_path(&path).and_then(|()| {
        windows::create_private_directory_with_parent_identity(&path, &expected_parent_identity)
    }),
    "private Windows directories are only available on Windows"
);

windows_security_export!(
    "protectPrivateWindowsFile",
    fn protect_private_windows_file(
        env: Env,
        fd: i32,
        path: String,
        expected_parent_identity: String,
    ) -> WindowsIdentityReceipt,
    validate_windows_filesystem_path(&path)
        .and_then(|()| windows::protect_private_file(fd, &path, &expected_parent_identity)),
    "private Windows file protection is only available on Windows"
);

windows_security_export!(
    "verifyPrivateWindowsFile",
    fn verify_private_windows_file(
        env: Env,
        fd: i32,
        path: String,
        expected_file_identity: String,
        expected_parent_identity: String,
        expected_links: u32,
    ) -> (),
    validate_windows_filesystem_path(&path).and_then(|()| {
        windows::verify_private_file(
            fd,
            &path,
            &expected_file_identity,
            &expected_parent_identity,
            expected_links,
        )
    }),
    "private Windows file verification is only available on Windows"
);

windows_security_export!(
    "readOwnerAndDacl",
    fn read_owner_and_dacl(env: Env, path: String) -> WindowsSecurityFacts,
    validate_windows_filesystem_path(&path).and_then(|()| windows::read_owner_and_dacl(&path)),
    "Windows owner and DACL inspection is only available on Windows"
);

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};

    use windows_sys::Wdk::Storage::FileSystem::{
        FileIsRemoteDeviceInformation as FILE_IS_REMOTE_DEVICE_INFORMATION_CLASS,
        NtQueryInformationFile,
    };
    use windows_sys::Win32::Foundation::{
        ERROR_INSUFFICIENT_BUFFER, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE,
        LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, SE_FILE_OBJECT,
        SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACCESS_DENIED_ACE, ACE_HEADER, ACL, CONTAINER_INHERIT_ACE,
        CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, InitializeSecurityDescriptor,
        IsValidSid, IsWellKnownSid, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PRESENT, SE_DACL_PROTECTED,
        SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TOKEN_QUERY, TOKEN_USER, TokenUser,
        WinAnonymousSid, WinAuthenticatedUserSid, WinBuiltinAdministratorsSid, WinBuiltinGuestsSid,
        WinBuiltinUsersSid, WinInteractiveSid, WinLocalSystemSid, WinNetworkSid, WinWorldSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE as DELETE_ACCESS, FILE_ADD_SUBDIRECTORY, FILE_ALL_ACCESS,
        FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_OPENED,
        FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_READ_EA, FILE_TRAVERSE, FILE_TYPE_DISK,
        FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, GetFileInformationByHandle,
        GetFileType, GetFinalPathNameByHandleW, READ_CONTROL, VOLUME_NAME_GUID, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{
        WindowsAccessControlEntry, WindowsIdentityReceipt, WindowsSecurityFacts, ace_flags,
    };
    use crate::{
        NativeResult, native_error,
        windows::{
            HandleFileIdentity, OwnedHandle, duplicate_handle, handle_attributes,
            handle_file_identity, mark_handle_for_deletion, nt_create_directory_relative,
            open_existing_handle, root_handle,
        },
    };

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

    #[repr(C)]
    struct FileIsRemoteDeviceInformation {
        // Windows BOOLEAN is one byte. Keep the raw byte so a malformed driver
        // response cannot construct an invalid Rust bool before we fall back.
        is_remote: u8,
    }

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
        owner_class: OwnerClass,
        dacl_protected: bool,
        dacl_present: bool,
        is_local: bool,
        ace_list_complete: bool,
        untrusted_readable: bool,
        untrusted_writable: bool,
        untrusted_child_access: bool,
    }

    fn current_user_sid() -> NativeResult<TokenSid> {
        let mut token: HANDLE = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(win_error(unsafe { GetLastError() }, "open process token"));
        }
        let token = OwnedHandle(token);
        let mut needed = 0_u32;
        unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
            return Err(win_error(unsafe { GetLastError() }, "size token user"));
        }
        let mut buffer = vec![0_u8; needed as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
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

    fn parse_basic_ace(raw: *mut c_void, header: &ACE_HEADER) -> NativeResult<Option<BasicAce>> {
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
        open_existing_handle(
            path,
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_FLAG_BACKUP_SEMANTICS,
            |code| win_error(code, "open path for locality check"),
        )
    }

    fn split_parent(path: &str) -> NativeResult<(PathBuf, String)> {
        if path.encode_utf16().any(|unit| unit == 0) {
            return Err(native_error("EINVAL", "Windows path contains a NUL byte"));
        }
        for component in path
            .split(['/', '\\'])
            .filter(|component| !component.is_empty())
        {
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
        let owned = open_existing_handle(
            &path,
            desired_access,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            |code| win_error(code, "open private directory parent"),
        )?;
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
        open_existing_handle(
            &path,
            FILE_READ_ATTRIBUTES,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            |code| win_error(code, "open private directory through its public path"),
        )
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
                    return Err(native_error(
                        "ENAMETOOLONG",
                        "final Windows path is too long",
                    ));
                }
                heap.try_reserve_exact(capacity.saturating_sub(heap.len()))
                    .map_err(|_| native_error("ENOMEM", "allocate final Windows path buffer"))?;
                heap.resize(capacity, 0);
                &mut heap
            };
            let written = query(handle, buffer)?;
            if written == 0 {
                return Err(native_error(
                    "EIO",
                    "final Windows path query returned zero",
                ));
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
                return Err(native_error(
                    "ENAMETOOLONG",
                    "final Windows path is too long",
                ));
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

    fn parse_remote_device_information(
        status: i32,
        transferred: usize,
        information: &FileIsRemoteDeviceInformation,
    ) -> Option<bool> {
        if status != 0
            || transferred != size_of::<FileIsRemoteDeviceInformation>()
            || information.is_remote > 1
        {
            return None;
        }
        Some(information.is_remote != 0)
    }

    fn query_is_remote_device(handle: HANDLE) -> Option<bool> {
        let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
        let mut information = FileIsRemoteDeviceInformation { is_remote: u8::MAX };
        let status = unsafe {
            NtQueryInformationFile(
                handle,
                &mut io,
                (&mut information as *mut FileIsRemoteDeviceInformation).cast(),
                size_of::<FileIsRemoteDeviceInformation>() as u32,
                FILE_IS_REMOTE_DEVICE_INFORMATION_CLASS,
            )
        };
        parse_remote_device_information(status, io.Information, &information)
    }

    fn is_local_handle_with_remote_query<RemoteQuery, Fallback>(
        handle: HANDLE,
        mut remote_query: RemoteQuery,
        mut fallback: Fallback,
    ) -> NativeResult<bool>
    where
        RemoteQuery: FnMut(HANDLE) -> Option<bool>,
        Fallback: FnMut(HANDLE) -> NativeResult<bool>,
    {
        match remote_query(handle) {
            Some(is_remote) => Ok(!is_remote),
            None => fallback(handle),
        }
    }

    fn is_local_handle_via_paths(handle: HANDLE) -> NativeResult<bool> {
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
                    GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
                };
                if written == 0 {
                    return Err(win_error(unsafe { GetLastError() }, "resolve final path"));
                }
                Ok(written as usize)
            },
        )
    }

    pub(super) fn is_local_handle(handle: HANDLE) -> NativeResult<bool> {
        is_local_handle_with_remote_query(handle, query_is_remote_device, is_local_handle_via_paths)
    }

    fn inspect_owner_and_dacl_handle(
        handle: HANDLE,
        current: &TokenSid,
        include_public_report: bool,
        local: bool,
    ) -> NativeResult<(HandleSecurityInspection, Option<WindowsSecurityFacts>)> {
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
            if descriptor.is_null() || owner.is_null() {
                return Err(native_error(
                    "EIO",
                    "Windows owner and DACL query returned incomplete descriptor data",
                ));
            }
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
                owner_class,
                dacl_protected: control & SE_DACL_PROTECTED != 0,
                dacl_present: control & SE_DACL_PRESENT != 0 && !dacl.is_null(),
                is_local: local,
                ace_list_complete: true,
                // An absent or null DACL grants unrestricted access.
                untrusted_readable: dacl.is_null(),
                untrusted_writable: dacl.is_null(),
                untrusted_child_access: dacl.is_null(),
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
                    if entry.ace_type == ACCESS_DENIED_ACE_TYPE {
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
                    if entry.flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8 != 0 {
                        inspection.untrusted_child_access |= readable || writable;
                    }
                    if entry.flags & INHERIT_ONLY_ACE_FLAG != 0 {
                        continue;
                    }
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
        if !descriptor.is_null() {
            unsafe { LocalFree(descriptor) };
        }
        result
    }

    fn read_owner_and_dacl_handle(
        handle: HANDLE,
        current: &TokenSid,
    ) -> NativeResult<HandleSecurityInspection> {
        let local = is_local_handle(handle).unwrap_or(false);
        inspect_owner_and_dacl_handle(handle, current, false, local)
            .map(|(inspection, _)| inspection)
    }

    pub(super) fn security_facts(
        handle: HANDLE,
        local: bool,
    ) -> NativeResult<WindowsSecurityFacts> {
        let current = current_user_sid()?;
        let (_, report) = inspect_owner_and_dacl_handle(handle, &current, true, local)?;
        report.ok_or_else(|| native_error("EIO", "Windows security report was not constructed"))
    }

    pub fn read_owner_and_dacl(path: &str) -> NativeResult<WindowsSecurityFacts> {
        let path = wide(path)?;
        let handle = open_security_handle(&path)?;
        // The pathname API preserves its historical structured fallback when
        // locality cannot be established. Secure reads use the stricter fd API.
        let local = is_local_handle(handle.0).unwrap_or(false);
        security_facts(handle.0, local)
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
        verify_private_parent_association(parent_path, parent, parent_identity)?;
        let named = open_private_directory_path(path)?;
        if final_private_directory_identity(named.0, final_locality)? != created_identity {
            return Err(native_error(
                "EIO",
                "private directory named association changed during validation",
            ));
        }
        Ok(())
    }

    fn verify_private_parent_association(
        parent_path: &Path,
        parent: &OwnedHandle,
        parent_identity: HandleFileIdentity,
    ) -> NativeResult<()> {
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
        Ok(())
    }

    fn validate_full_identity(identity: &str) -> NativeResult<()> {
        if identity.len() != 49
            || !identity.bytes().enumerate().all(|(index, byte)| {
                if index == 16 {
                    byte == b':'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }
            })
        {
            return Err(native_error(
                "EINVAL",
                "full Windows file identity is invalid",
            ));
        }
        Ok(())
    }

    pub fn inspect_directory(
        path: &str,
        require_private: bool,
    ) -> NativeResult<WindowsIdentityReceipt> {
        let access =
            PRIVATE_PARENT_METADATA_ACCESS | if require_private { READ_CONTROL } else { 0 };
        let (directory, identity) = open_private_directory_parent(Path::new(path), access)?;
        if require_private {
            let current = current_user_sid()?;
            let inspection = read_owner_and_dacl_handle(directory.0, &current)?;
            validate_private_directory_facts(&inspection)?;
            if inspection.untrusted_child_access {
                return Err(native_error(
                    "EACCES",
                    "private directory permits untrusted child access",
                ));
            }
        }
        Ok(WindowsIdentityReceipt {
            identity: identity.to_string(),
        })
    }

    fn private_file_identity(
        handle: HANDLE,
        expected_links: u32,
    ) -> NativeResult<HandleFileIdentity> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
            return Err(win_error(unsafe { GetLastError() }, "inspect private file"));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(native_error(
                "ELOOP",
                "private file must not be a reparse point",
            ));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
            || unsafe { GetFileType(handle) } != FILE_TYPE_DISK
        {
            return Err(native_error(
                "EINVAL",
                "private file must be a regular disk file",
            ));
        }
        if info.nNumberOfLinks != expected_links {
            return Err(native_error("EIO", "private file link count changed"));
        }
        handle_file_identity(handle)
    }

    fn verify_private_file_association(
        handle: HANDLE,
        path: &str,
        identity: HandleFileIdentity,
        expected_links: u32,
        parent_path: &Path,
        parent: &OwnedHandle,
        parent_identity: HandleFileIdentity,
    ) -> NativeResult<()> {
        if private_file_identity(handle, expected_links)? != identity {
            return Err(native_error("EIO", "retained private file changed"));
        }
        let named = open_existing_handle(
            &wide(path)?,
            FILE_READ_ATTRIBUTES,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            |code| win_error(code, "open private file through its public path"),
        )?;
        if private_file_identity(named.0, expected_links)? != identity {
            return Err(native_error("EIO", "private file pathname changed"));
        }
        verify_private_parent_association(parent_path, parent, parent_identity)
    }

    #[derive(Clone, Copy)]
    enum PrivateFileOperation<'a> {
        Protect,
        Verify { identity: &'a str, links: u32 },
    }

    fn private_file_with_handle(
        handle: HANDLE,
        path: &str,
        expected_parent_identity: &str,
        operation: PrivateFileOperation<'_>,
    ) -> NativeResult<WindowsIdentityReceipt> {
        validate_full_identity(expected_parent_identity)?;
        let links = match operation {
            PrivateFileOperation::Protect => 1,
            PrivateFileOperation::Verify { identity, links } => {
                validate_full_identity(identity)?;
                if links == 0 {
                    return Err(native_error(
                        "EINVAL",
                        "private file expected link count is invalid",
                    ));
                }
                links
            }
        };
        let identity = private_file_identity(handle, links)?;
        if let PrivateFileOperation::Verify {
            identity: expected, ..
        } = operation
        {
            if identity.to_string() != expected {
                return Err(native_error("EIO", "private file identity changed"));
            }
        }
        let protect = matches!(operation, PrivateFileOperation::Protect);
        let current = current_user_sid()?;
        // Protection may tighten inherited private access, but cannot revoke a
        // reader admitted while the file had a broadly accessible DACL.
        validate_private_facts(
            &read_owner_and_dacl_handle(handle, &current)?,
            !protect,
            "file",
        )?;
        let (parent_path, _) = split_parent(path)?;
        let (parent, parent_identity) =
            open_private_directory_parent(&parent_path, PRIVATE_PARENT_METADATA_ACCESS)?;
        if parent_identity.to_string() != expected_parent_identity {
            return Err(native_error("EIO", "private parent identity changed"));
        }
        verify_private_file_association(
            handle,
            path,
            identity,
            links,
            &parent_path,
            &parent,
            parent_identity,
        )?;
        if protect {
            let writable = open_existing_handle(
                &wide(path)?,
                FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                |code| win_error(code, "open private file for DACL protection"),
            )?;
            if private_file_identity(writable.0, links)? != identity {
                return Err(native_error(
                    "EIO",
                    "private file changed before DACL protection",
                ));
            }
            validate_private_facts(
                &read_owner_and_dacl_handle(writable.0, &current)?,
                false,
                "file",
            )?;
            let acl = private_acl(&current, false)?;
            verify_private_parent_association(&parent_path, &parent, parent_identity)?;
            let status = unsafe {
                SetSecurityInfo(
                    writable.0,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION
                        | DACL_SECURITY_INFORMATION
                        | PROTECTED_DACL_SECURITY_INFORMATION,
                    current.sid,
                    null_mut(),
                    acl.0,
                    null_mut(),
                )
            };
            if status != 0 {
                return Err(win_error(status, "protect private file security"));
            }
            validate_private_facts(
                &read_owner_and_dacl_handle(writable.0, &current)?,
                true,
                "file",
            )?;
        }
        validate_private_facts(&read_owner_and_dacl_handle(handle, &current)?, true, "file")?;
        verify_private_file_association(
            handle,
            path,
            identity,
            links,
            &parent_path,
            &parent,
            parent_identity,
        )?;
        Ok(WindowsIdentityReceipt {
            identity: identity.to_string(),
        })
    }

    pub fn protect_private_file(
        fd: i32,
        path: &str,
        expected_parent_identity: &str,
    ) -> NativeResult<WindowsIdentityReceipt> {
        let held = duplicate_handle(root_handle(fd)?, "duplicate borrowed private file handle")?;
        private_file_with_handle(
            held.0,
            path,
            expected_parent_identity,
            PrivateFileOperation::Protect,
        )
    }

    pub fn verify_private_file(
        fd: i32,
        path: &str,
        expected_file_identity: &str,
        expected_parent_identity: &str,
        expected_links: u32,
    ) -> NativeResult<()> {
        let held = duplicate_handle(root_handle(fd)?, "duplicate borrowed private file handle")?;
        private_file_with_handle(
            held.0,
            path,
            expected_parent_identity,
            PrivateFileOperation::Verify {
                identity: expected_file_identity,
                links: expected_links,
            },
        )
        .map(|_| ())
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

    fn validate_private_directory_facts(inspection: &HandleSecurityInspection) -> NativeResult<()> {
        validate_private_facts(inspection, true, "directory")
    }

    fn validate_private_facts(
        inspection: &HandleSecurityInspection,
        require_final_security: bool,
        kind: &str,
    ) -> NativeResult<()> {
        // Elevated tokens can give newly created files an Administrators owner.
        // Admit that inherited state only until the pinned file's owner is set.
        let owner_admitted = inspection.owner_class == OwnerClass::CurrentUser
            || (!require_final_security && inspection.owner_class == OwnerClass::Administrators);
        if (require_final_security && !inspection.dacl_protected)
            || !owner_admitted
            || !inspection.dacl_present
            || !inspection.is_local
            || !inspection.ace_list_complete
            || inspection.untrusted_readable
            || inspection.untrusted_writable
        {
            return Err(native_error(
                "EACCES",
                format!("filesystem did not enforce the private {kind} DACL"),
            ));
        }
        Ok(())
    }

    struct PrivateAcl(*mut ACL);

    impl Drop for PrivateAcl {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0.cast()) };
        }
    }

    fn private_acl(current: &TokenSid, inherit: bool) -> NativeResult<PrivateAcl> {
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
            entry.grfInheritance = if inherit {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            entry.Trustee.ptstrName = sid.cast();
        }
        let mut acl: *mut ACL = null_mut();
        let status =
            unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), null(), &mut acl) };
        if status != 0 {
            return Err(win_error(status, "build private object DACL"));
        }
        Ok(PrivateAcl(acl))
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
        expected_parent_identity: Option<&str>,
        mut after_create: AfterCreate,
        mut query_created: QueryCreated,
        mut after_validation: AfterValidation,
        mut inspect: Inspect,
        mut final_locality: FinalLocality,
    ) -> NativeResult<HandleFileIdentity>
    where
        AfterCreate: FnMut(),
        QueryCreated: FnMut(HANDLE) -> NativeResult<HandleFileIdentity>,
        AfterValidation: FnMut(),
        Inspect: FnMut(HANDLE, &TokenSid) -> NativeResult<HandleSecurityInspection>,
        FinalLocality: FnMut(HANDLE) -> NativeResult<bool>,
    {
        if let Some(expected) = expected_parent_identity {
            validate_full_identity(expected)?;
        }
        let (parent_path, name) = split_parent(path)?;
        let (parent, parent_identity) =
            open_private_directory_parent(&parent_path, PRIVATE_PARENT_CREATE_ACCESS)?;
        if expected_parent_identity.is_some_and(|expected| parent_identity.to_string() != expected)
        {
            return Err(native_error(
                "EIO",
                "private parent changed before creation",
            ));
        }
        let current = current_user_sid()?;
        let acl = private_acl(&current, true)?;
        (|| {
            let mut descriptor: SECURITY_DESCRIPTOR = unsafe { zeroed() };
            let descriptor_ptr = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
            if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) }
                == 0
                || unsafe { SetSecurityDescriptorOwner(descriptor_ptr, current.sid, 0) } == 0
                || unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl.0, 0) } == 0
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
                )?;
                Ok(created_identity)
            })();
            operation.map_err(|error| {
                with_private_directory_cleanup_error(error, mark_handle_for_deletion(created.0))
            })
        })()
    }

    pub fn create_private_directory(path: &str) -> NativeResult<()> {
        create_private_directory_with_hooks(
            path,
            None,
            || {},
            created_directory_identity,
            || {},
            read_owner_and_dacl_handle,
            is_local_handle,
        )
        .map(|_| ())
    }

    pub fn create_private_directory_with_parent_identity(
        path: &str,
        expected_parent_identity: &str,
    ) -> NativeResult<WindowsIdentityReceipt> {
        create_private_directory_with_hooks(
            path,
            Some(expected_parent_identity),
            || {},
            created_directory_identity,
            || {},
            read_owner_and_dacl_handle,
            is_local_handle,
        )
        .map(|identity| WindowsIdentityReceipt {
            identity: identity.to_string(),
        })
    }

    #[cfg(test)]
    mod tests {
        use std::cell::Cell;
        use std::fs::{self, OpenOptions};
        use std::io::Write;
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
                owner_class: OwnerClass::CurrentUser,
                dacl_protected: true,
                dacl_present: true,
                is_local: true,
                ace_list_complete: true,
                untrusted_readable: false,
                untrusted_writable: false,
                untrusted_child_access: false,
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

            let too_long =
                final_path_with_query(handle, |_, _| Ok(MAX_FINAL_PATH_WCHARS + 1)).unwrap_err();
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
        fn remote_device_fast_path_is_bounded_and_falls_back() {
            let local = FileIsRemoteDeviceInformation { is_remote: 0 };
            let remote = FileIsRemoteDeviceInformation { is_remote: 1 };
            assert_eq!(
                parse_remote_device_information(
                    0,
                    size_of::<FileIsRemoteDeviceInformation>(),
                    &local,
                ),
                Some(false)
            );
            assert_eq!(
                parse_remote_device_information(
                    0,
                    size_of::<FileIsRemoteDeviceInformation>(),
                    &remote,
                ),
                Some(true)
            );
            for (status, transferred, value) in [
                (1, size_of::<FileIsRemoteDeviceInformation>(), 0),
                (0, 0, 0),
                (0, size_of::<FileIsRemoteDeviceInformation>() + 1, 0),
                (0, size_of::<FileIsRemoteDeviceInformation>(), 2),
            ] {
                assert_eq!(
                    parse_remote_device_information(
                        status,
                        transferred,
                        &FileIsRemoteDeviceInformation { is_remote: value },
                    ),
                    None
                );
            }

            let handle = null_mut();
            assert!(
                is_local_handle_with_remote_query(
                    handle,
                    |_| Some(false),
                    |_| -> NativeResult<bool> { panic!("local result must not fall back") },
                )
                .unwrap()
            );
            assert!(
                !is_local_handle_with_remote_query(
                    handle,
                    |_| Some(true),
                    |_| -> NativeResult<bool> { panic!("remote result must not fall back") },
                )
                .unwrap()
            );
            let fallback_calls = Cell::new(0);
            assert!(
                is_local_handle_with_remote_query(
                    handle,
                    |_| None,
                    |_| {
                        fallback_calls.set(fallback_calls.get() + 1);
                        Ok(true)
                    },
                )
                .unwrap()
            );
            assert_eq!(fallback_calls.get(), 1);

            let error = is_local_handle_with_remote_query(
                handle,
                |_| None,
                |_| Err(native_error("fallback-failed", "injected fallback failure")),
            )
            .unwrap_err();
            assert_eq!(error.status, "fallback-failed");
            assert_eq!(error.reason, "injected fallback failure");
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
                    owner_class: OwnerClass::Foreign,
                    ..valid
                },
                HandleSecurityInspection {
                    owner_class: OwnerClass::Administrators,
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
                None,
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
            assert_eq!(inspection.owner_class.as_str(), facts.owner_class);
            assert_eq!(inspection.dacl_present, facts.dacl_present);
            assert_eq!(inspection.is_local, facts.is_local);
            assert_eq!(inspection.ace_list_complete, facts.ace_list_complete);
            assert!(facts.unsupported_ace_types.is_empty());
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
        fn parent_receipts_admit_only_the_exact_directory_before_creation() {
            let root = temp_root("parent-receipt");
            let target = root.join("private");
            let receipt = inspect_directory(root.to_str().unwrap(), false).unwrap();
            for index in [0, 17, 48] {
                let mut stale = receipt.identity.clone();
                let replacement = if &stale[index..index + 1] == "0" {
                    "1"
                } else {
                    "0"
                };
                stale.replace_range(index..index + 1, replacement);
                let error =
                    create_private_directory_with_parent_identity(target.to_str().unwrap(), &stale)
                        .unwrap_err();
                assert_eq!(error.status, "EIO");
                assert!(!target.exists());
            }
            let created = create_private_directory_with_parent_identity(
                target.to_str().unwrap(),
                &receipt.identity,
            )
            .unwrap();
            assert_eq!(
                inspect_directory(target.to_str().unwrap(), true)
                    .unwrap()
                    .identity,
                created.identity,
            );
            let file = root.join("file");
            fs::write(&file, b"sentinel").unwrap();
            assert_eq!(
                inspect_directory(file.to_str().unwrap(), false)
                    .unwrap_err()
                    .status,
                "ENOTDIR",
            );
            assert_eq!(fs::read(&file).unwrap(), b"sentinel");
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn private_directory_inspection_rejects_broad_inherit_only_grants() {
            let root = temp_root("child-inheritance");
            let target = root.join("private");
            create_private_directory(target.to_str().unwrap()).unwrap();
            let writable = open_existing_handle(
                &wide(target.to_str().unwrap()).unwrap(),
                READ_CONTROL | WRITE_DAC,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                |code| win_error(code, "open synthetic inheritance fixture"),
            )
            .unwrap();
            let current = current_user_sid().unwrap();
            let base = private_acl(&current, true).unwrap();
            let world = well_known_sid(WinWorldSid).unwrap();
            let mut entry: EXPLICIT_ACCESS_W = unsafe { zeroed() };
            entry.grfAccessPermissions = FILE_READ_DATA;
            entry.grfAccessMode = GRANT_ACCESS;
            entry.grfInheritance =
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE_FLAG as u32;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            entry.Trustee.ptstrName = world.as_ptr().cast_mut().cast();
            let mut extended = null_mut();
            assert_eq!(
                unsafe { SetEntriesInAclW(1, &entry, base.0, &mut extended) },
                0
            );
            let extended = PrivateAcl(extended);
            assert_eq!(
                unsafe {
                    SetSecurityInfo(
                        writable.0,
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        extended.0,
                        null_mut(),
                    )
                },
                0
            );
            // The directory itself is private; its child inheritance is not.
            assert!(!security_facts(writable.0, true).unwrap().world_readable);
            assert!(inspect_directory(target.to_str().unwrap(), false).is_ok());
            assert_eq!(
                inspect_directory(target.to_str().unwrap(), true)
                    .unwrap_err()
                    .status,
                "EACCES"
            );
            drop(writable);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn protects_inherited_private_file_and_verifies_publication_links() {
            let root = temp_root("private-file-publication");
            let stage = root.join("stage");
            create_private_directory(stage.to_str().unwrap()).unwrap();
            let stage_receipt = inspect_directory(stage.to_str().unwrap(), true).unwrap();
            let root_receipt = inspect_directory(root.to_str().unwrap(), false).unwrap();
            let source = stage.join("file");
            let published = root.join("published");
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .open(&source)
                .unwrap();
            let handle = file.as_raw_handle() as HANDLE;
            let current = current_user_sid().unwrap();
            assert!(
                !read_owner_and_dacl_handle(handle, &current)
                    .unwrap()
                    .dacl_protected
            );
            let receipt = private_file_with_handle(
                handle,
                source.to_str().unwrap(),
                &stage_receipt.identity,
                PrivateFileOperation::Protect,
            )
            .unwrap();
            assert_eq!(
                receipt.identity,
                handle_file_identity(handle).unwrap().to_string()
            );
            let facts = security_facts(handle, true).unwrap();
            assert_eq!(facts.owner_class, "current-user");
            assert_eq!(facts.owner_sid, facts.current_user_sid);
            assert!(facts.aces.iter().all(|ace| ace.flags.raw == 0));
            file.write_all(b"still owned by the caller").unwrap();
            fs::hard_link(&source, &published).unwrap();
            let error = private_file_with_handle(
                handle,
                published.to_str().unwrap(),
                &root_receipt.identity,
                PrivateFileOperation::Verify {
                    identity: &receipt.identity,
                    links: 1,
                },
            )
            .unwrap_err();
            assert_eq!(error.status, "EIO");
            private_file_with_handle(
                handle,
                published.to_str().unwrap(),
                &root_receipt.identity,
                PrivateFileOperation::Verify {
                    identity: &receipt.identity,
                    links: 2,
                },
            )
            .unwrap();
            // Keep the same object retained while changing the opened name, as
            // required before removing a Windows staging directory.
            let retained = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .open(&published)
                .unwrap();
            assert_eq!(
                handle_file_identity(retained.as_raw_handle() as HANDLE)
                    .unwrap()
                    .to_string(),
                receipt.identity
            );
            drop(file);
            fs::remove_file(&source).unwrap();
            fs::remove_dir(&stage).unwrap();
            let handle = retained.as_raw_handle() as HANDLE;
            private_file_with_handle(
                handle,
                published.to_str().unwrap(),
                &root_receipt.identity,
                PrivateFileOperation::Verify {
                    identity: &receipt.identity,
                    links: 1,
                },
            )
            .unwrap();
            let mut wrong_identity = receipt.identity.clone();
            wrong_identity.replace_range(
                17..18,
                if &receipt.identity[17..18] == "0" {
                    "1"
                } else {
                    "0"
                },
            );
            assert_eq!(
                private_file_with_handle(
                    handle,
                    published.to_str().unwrap(),
                    &root_receipt.identity,
                    PrivateFileOperation::Verify {
                        identity: &wrong_identity,
                        links: 1
                    },
                )
                .unwrap_err()
                .status,
                "EIO"
            );
            assert_eq!(fs::read(&published).unwrap(), b"still owned by the caller");
            drop(retained);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn private_file_protection_rejects_changed_admission_without_mutation() {
            for scenario in ["parent", "pathname", "hardlink", "broad-acl"] {
                let root = temp_root(scenario);
                let stage = root.join("stage");
                create_private_directory(stage.to_str().unwrap()).unwrap();
                let mut parent_identity = inspect_directory(stage.to_str().unwrap(), true)
                    .unwrap()
                    .identity;
                let source = stage.join("file");
                let original = stage.join("original");
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                    .open(&source)
                    .unwrap();
                fs::write(&source, b"original").unwrap();
                let handle = file.as_raw_handle() as HANDLE;
                match scenario {
                    "parent" => {
                        parent_identity = inspect_directory(root.to_str().unwrap(), false)
                            .unwrap()
                            .identity
                    }
                    "pathname" => {
                        fs::rename(&source, &original).unwrap();
                        fs::write(&source, b"replacement").unwrap();
                    }
                    "hardlink" => fs::hard_link(&source, &original).unwrap(),
                    "broad-acl" => {
                        let writable = open_existing_handle(
                            &wide(source.to_str().unwrap()).unwrap(),
                            READ_CONTROL | WRITE_DAC,
                            FILE_FLAG_OPEN_REPARSE_POINT,
                            |code| win_error(code, "open synthetic broad-ACL fixture"),
                        )
                        .unwrap();
                        let current = current_user_sid().unwrap();
                        let base = private_acl(&current, false).unwrap();
                        let world = well_known_sid(WinWorldSid).unwrap();
                        let mut entry: EXPLICIT_ACCESS_W = unsafe { zeroed() };
                        entry.grfAccessPermissions = FILE_READ_DATA;
                        entry.grfAccessMode = GRANT_ACCESS;
                        entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
                        entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
                        entry.Trustee.ptstrName = world.as_ptr().cast_mut().cast();
                        let mut extended = null_mut();
                        assert_eq!(
                            unsafe { SetEntriesInAclW(1, &entry, base.0, &mut extended) },
                            0
                        );
                        let extended = PrivateAcl(extended);
                        assert_eq!(
                            unsafe {
                                SetSecurityInfo(
                                    writable.0,
                                    SE_FILE_OBJECT,
                                    DACL_SECURITY_INFORMATION,
                                    null_mut(),
                                    null_mut(),
                                    extended.0,
                                    null_mut(),
                                )
                            },
                            0
                        );
                    }
                    _ => unreachable!(),
                }
                let current = current_user_sid().unwrap();
                let before = read_owner_and_dacl_handle(handle, &current).unwrap();
                if scenario == "broad-acl" {
                    assert!(before.dacl_present);
                    assert!(before.untrusted_readable);
                    assert!(!before.dacl_protected);
                }
                let error = private_file_with_handle(
                    handle,
                    source.to_str().unwrap(),
                    &parent_identity,
                    PrivateFileOperation::Protect,
                )
                .unwrap_err();
                assert_eq!(
                    error.status,
                    if scenario == "broad-acl" {
                        "EACCES"
                    } else {
                        "EIO"
                    }
                );
                let after = read_owner_and_dacl_handle(handle, &current).unwrap();
                assert_eq!(after.owner_class, before.owner_class);
                assert_eq!(after.dacl_protected, before.dacl_protected);
                assert_eq!(after.dacl_present, before.dacl_present);
                assert_eq!(after.untrusted_readable, before.untrusted_readable);
                if scenario == "pathname" {
                    assert_eq!(fs::read(&source).unwrap(), b"replacement");
                    assert_eq!(fs::read(&original).unwrap(), b"original");
                    let replacement = open_existing_handle(
                        &wide(source.to_str().unwrap()).unwrap(),
                        READ_CONTROL | FILE_READ_ATTRIBUTES,
                        FILE_FLAG_OPEN_REPARSE_POINT,
                        |code| win_error(code, "open replacement fixture"),
                    )
                    .unwrap();
                    assert!(
                        !read_owner_and_dacl_handle(replacement.0, &current)
                            .unwrap()
                            .dacl_protected
                    );
                } else {
                    assert_eq!(fs::read(&source).unwrap(), b"original");
                }
                drop(file);
                fs::remove_dir_all(root).unwrap();
            }
        }

        #[test]
        fn rejects_an_unprotected_created_directory_and_cleans_its_handle() {
            let root = temp_root("unprotected-dacl");
            let target = root.join("private");

            let error = create_private_directory_with_hooks(
                target.to_str().unwrap(),
                None,
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
                None,
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
                None,
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
                None,
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
                None,
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
                None,
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
                None,
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
                None,
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
                None,
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

#[cfg(windows)]
pub(crate) fn read_owner_and_dacl_for_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> NativeResult<WindowsSecurityFacts> {
    let local = windows::is_local_handle(handle)?;
    windows::security_facts(handle, local)
}

#[cfg(test)]
mod tests {
    use super::ace_flags;

    #[test]
    fn unsupported_export_arguments_preserve_drop_boundaries() {
        use std::cell::RefCell;

        struct Witness<'a>(&'a RefCell<Vec<&'static str>>, &'static str);
        impl Drop for Witness<'_> {
            fn drop(&mut self) {
                self.0.borrow_mut().push(self.1);
            }
        }

        let events = RefCell::new(Vec::new());
        {
            let scalar = Witness(&events, "scalar");
            let _ = crate::windows_security::windows_security_export!(
                @unused scalar: Witness<'_>,
            );
            events.borrow_mut().push("following scalar work");
            assert_eq!(events.borrow().as_slice(), ["following scalar work"]);
        }
        assert_eq!(
            events.borrow().as_slice(),
            ["following scalar work", "scalar"]
        );

        events.borrow_mut().clear();
        {
            let first = Witness(&events, "first");
            let second = Witness(&events, "second");
            let third = Witness(&events, "third");
            let _: (Witness<'_>, Witness<'_>, Witness<'_>) = crate::windows_security::windows_security_export!(
                @unused first: Witness<'_>, second: Witness<'_>, third: Witness<'_>,
            );
            events.borrow_mut().push("following tuple work");
        }
        assert_eq!(
            events.borrow().as_slice(),
            ["first", "second", "third", "following tuple work"]
        );
    }

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
