use napi::{Env, Result};
use napi_derive::napi;

use crate::into_napi;
#[cfg(not(windows))]
use crate::native_error;
use crate::windows_security::{windows_security_export, WindowsSecurityFacts};

#[napi(object)]
pub struct WindowsDescriptorSecurityFacts {
    /// Canonical 32-bit volume serial and 64-bit file-index projection used by Node.
    /// This is not the full 128-bit file identity available on ReFS.
    pub identity: String,
    pub security: WindowsSecurityFacts,
}

windows_security_export!(
    "inspectWindowsSecureFileHandle",
    fn inspect_windows_secure_file_handle(env: Env, fd: i32) -> WindowsDescriptorSecurityFacts,
    windows::inspect(fd),
    fd,
    "Windows descriptor security inspection is only available on Windows"
);

#[cfg(windows)]
mod windows {
    use super::WindowsDescriptorSecurityFacts;
    use crate::NativeResult;
    use crate::windows::{duplicate_handle, handle_identity, root_handle};

    pub(super) fn inspect(fd: i32) -> NativeResult<WindowsDescriptorSecurityFacts> {
        let handle = duplicate_handle(root_handle(fd)?, "duplicate borrowed Node file handle")?;
        let (volume, file_index, _is_directory) = handle_identity(handle.0)?;
        let security = crate::windows_security::read_owner_and_dacl_for_handle(handle.0)?;
        Ok(WindowsDescriptorSecurityFacts {
            identity: format!("{volume:08x}:{file_index:016x}"),
            security,
        })
    }
}
