use napi::{Env, Result};
use napi_derive::napi;

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
    return into_napi(
        env,
        validate_windows_filesystem_path(&path)
            .and_then(|()| windows::create_private_directory(&path)),
    );
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
    return into_napi(
        env,
        validate_windows_filesystem_path(&path).and_then(|()| windows::read_owner_and_dacl(&path)),
    );
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
        GetTokenInformation, InitializeSecurityDescriptor, IsValidSid, IsWellKnownSid,
        OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED,
        SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
        TOKEN_QUERY, TOKEN_USER, TokenUser, WinAnonymousSid, WinAuthenticatedUserSid,
        WinBuiltinAdministratorsSid, WinBuiltinGuestsSid, WinBuiltinUsersSid, WinInteractiveSid,
        WinLocalSystemSid, WinNetworkSid, WinWorldSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        GetFinalPathNameByHandleW, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{WindowsAccessControlEntry, WindowsSecurityFacts, ace_flags};
    use crate::{NativeResult, native_error};

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
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

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
    ) -> NativeResult<Option<(WindowsAccessControlEntry, PSID)>> {
        let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
        if (header.AceSize as usize) < sid_offset + 8 {
            return Ok(None);
        }
        let (mask, sid, ace_type) = match header.AceType {
            ACCESS_ALLOWED_ACE_TYPE => {
                let ace = unsafe { &*(raw.cast::<ACCESS_ALLOWED_ACE>()) };
                (
                    ace.Mask,
                    (&ace.SidStart as *const u32).cast_mut().cast::<c_void>(),
                    "allow",
                )
            }
            ACCESS_DENIED_ACE_TYPE => {
                let ace = unsafe { &*(raw.cast::<ACCESS_DENIED_ACE>()) };
                (
                    ace.Mask,
                    (&ace.SidStart as *const u32).cast_mut().cast::<c_void>(),
                    "deny",
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
        Ok(Some((
            WindowsAccessControlEntry {
                sid: sid_string(sid)?,
                mask,
                ace_type: ace_type.to_owned(),
                flags: ace_flags(header.AceFlags),
            },
            sid,
        )))
    }

    fn open_security_handle(path: &[u16]) -> NativeResult<HANDLE> {
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
        Ok(handle)
    }

    fn is_local_handle(handle: HANDLE) -> NativeResult<bool> {
        let needed = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
        if needed == 0 {
            return Err(win_error(unsafe { GetLastError() }, "size final path"));
        }
        let mut buffer = vec![0_u16; needed as usize + 1];
        let written = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        };
        if written == 0 || written as usize >= buffer.len() {
            return Err(win_error(unsafe { GetLastError() }, "resolve final path"));
        }
        let final_path = String::from_utf16_lossy(&buffer[..written as usize]);
        Ok(!final_path.starts_with(r"\\?\UNC\")
            && (!final_path.starts_with(r"\\") || final_path.starts_with(r"\\?\")))
    }

    pub fn read_owner_and_dacl(path: &str) -> NativeResult<WindowsSecurityFacts> {
        let path = wide(path)?;
        let current = current_user_sid()?;
        let handle = open_security_handle(&path)?;
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
            unsafe { CloseHandle(handle) };
            return Err(win_error(status, "read owner and DACL"));
        }
        let result = (|| {
            let owner_class = if unsafe { EqualSid(owner, current.sid) } != 0 {
                "current-user"
            } else if unsafe { IsWellKnownSid(owner, WinLocalSystemSid) } != 0 {
                "system"
            } else if unsafe { IsWellKnownSid(owner, WinBuiltinAdministratorsSid) } != 0 {
                "administrators"
            } else {
                "foreign"
            };
            let mut facts = WindowsSecurityFacts {
                owner_sid: sid_string(owner)?,
                current_user_sid: sid_string(current.sid)?,
                owner_class: owner_class.to_owned(),
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
            };
            if !dacl.is_null() {
                let count = unsafe { (*dacl).AceCount } as u32;
                for index in 0..count {
                    let mut raw = null_mut();
                    if unsafe { GetAce(dacl, index, &mut raw) } == 0 || raw.is_null() {
                        facts.fallback_required = true;
                        facts.ace_list_complete = false;
                        continue;
                    }
                    let header = unsafe { &*(raw.cast::<ACE_HEADER>()) };
                    let Some((entry, sid)) = parse_basic_ace(raw, header)? else {
                        facts.fallback_required = true;
                        facts.ace_list_complete = false;
                        facts.unsupported_ace_types.push(header.AceType.into());
                        continue;
                    };
                    let mask = entry.mask;
                    let inherit_only = entry.flags.inherit_only;
                    facts.aces.push(entry);
                    if inherit_only || header.AceType == ACCESS_DENIED_ACE_TYPE {
                        continue;
                    }
                    let trusted = unsafe { EqualSid(sid, current.sid) } != 0
                        || unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } != 0
                        || unsafe { IsWellKnownSid(sid, WinBuiltinAdministratorsSid) } != 0;
                    if trusted {
                        continue;
                    }
                    if is_world_sid(sid) {
                        facts.world_readable |= can_read(mask);
                        facts.world_writable |= can_write(mask);
                    } else {
                        facts.group_readable |= can_read(mask);
                        facts.group_writable |= can_write(mask);
                    }
                }
            }
            Ok(facts)
        })();
        unsafe { LocalFree(descriptor) };
        unsafe { CloseHandle(handle) };
        result
    }

    pub fn create_private_directory(path: &str) -> NativeResult<()> {
        let path_wide = wide(path)?;
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
        let mut created = false;
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
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor_ptr,
                bInheritHandle: 0,
            };
            if unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) } == 0 {
                return Err(win_error(
                    unsafe { GetLastError() },
                    "create private directory",
                ));
            }
            created = true;
            let facts = read_owner_and_dacl(path)?;
            if facts.owner_class != "current-user"
                || facts.world_readable
                || facts.world_writable
                || facts.group_readable
                || facts.group_writable
                || facts.fallback_required
            {
                return Err(native_error(
                    "EACCES",
                    "filesystem did not enforce the private directory DACL",
                ));
            }
            Ok(())
        })();
        unsafe { LocalFree(acl.cast()) };
        if created && result.is_err() {
            unsafe {
                windows_sys::Win32::Storage::FileSystem::RemoveDirectoryW(path_wide.as_ptr())
            };
        }
        result
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
