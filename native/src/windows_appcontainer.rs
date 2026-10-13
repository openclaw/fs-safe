use std::mem::size_of;
use std::ptr::null_mut;
use std::sync::OnceLock;

use crate::windows::{OwnedHandle, win_error};
use crate::{NativeError, NativeResult, native_error};
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TokenIsAppContainer};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn probe() -> NativeResult<bool> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "open process token"));
    }
    let token = OwnedHandle(token);
    let mut contained = 0_u32;
    let mut returned = 0;
    if unsafe {
        GetTokenInformation(token.0, TokenIsAppContainer, (&mut contained as *mut u32).cast(),
            size_of::<u32>() as u32, &mut returned)
    } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "read token AppContainer status"));
    }
    if returned != size_of::<u32>() as u32 || contained > 1 {
        return Err(native_error("EIO", "process AppContainer status is invalid"));
    }
    Ok(contained != 0)
}

pub(crate) fn is_app_container() -> NativeResult<bool> {
    // Primary-token AppContainer membership is immutable and shared by Workers.
    static MEMBERSHIP: OnceLock<NativeResult<bool>> = OnceLock::new();
    MEMBERSHIP.get_or_init(probe).as_ref().copied().map_err(|error| NativeError {
        status: error.status.clone(), reason: error.reason.clone(), errno: error.errno,
    })
}

#[napi_derive::napi(js_name = "isWindowsAppContainer")]
pub fn is_windows_app_container(env: napi::Env) -> napi::Result<bool> {
    crate::into_napi(env, is_app_container())
}
