use napi::{Env, Result};
use napi_derive::napi;

use crate::into_napi;
#[cfg(not(windows))]
use crate::native_error;
use crate::windows_security::WindowsSecurityFacts;

#[napi(object)]
pub struct WindowsDescriptorSecurityFacts {
    /// Canonical 32-bit volume serial and 64-bit file-index projection used by Node.
    /// This is not the full 128-bit file identity available on ReFS.
    pub identity: String,
    pub security: WindowsSecurityFacts,
}

#[napi(js_name = "inspectWindowsSecureFileHandle")]
pub fn inspect_windows_secure_file_handle(
    env: Env,
    fd: i32,
) -> Result<WindowsDescriptorSecurityFacts> {
    #[cfg(windows)]
    return into_napi(env, windows::inspect(fd));
    #[cfg(not(windows))]
    {
        let _ = fd;
        into_napi(
            env,
            Err(native_error(
                "ENOTSUP",
                "Windows descriptor security inspection is only available on Windows",
            )),
        )
    }
}

#[cfg(windows)]
mod windows {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, GetLastError};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    use super::WindowsDescriptorSecurityFacts;
    use crate::NativeResult;
    use crate::windows::{OwnedHandle, handle_identity, root_handle, win_error};

    fn duplicate_node_handle(fd: i32) -> NativeResult<OwnedHandle> {
        let borrowed = root_handle(fd)?;
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate = null_mut();
        if unsafe {
            DuplicateHandle(
                process,
                borrowed,
                process,
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(win_error(
                unsafe { GetLastError() },
                "duplicate borrowed Node file handle",
            ));
        }
        Ok(OwnedHandle(duplicate))
    }

    pub(super) fn inspect(fd: i32) -> NativeResult<WindowsDescriptorSecurityFacts> {
        let handle = duplicate_node_handle(fd)?;
        let (volume, file_index, _is_directory) = handle_identity(handle.0)?;
        let security = crate::windows_security::read_owner_and_dacl_for_handle(handle.0)?;
        Ok(WindowsDescriptorSecurityFacts {
            identity: format!("{volume:08x}:{file_index:016x}"),
            security,
        })
    }
}
