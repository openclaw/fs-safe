#![deny(unsafe_op_in_unsafe_fn)]

// The complete filesystem backend is qualified only on Linux, macOS and Windows.
// FreeBSD exports its independently qualified capabilities, never placeholder methods.
#[cfg(not(target_os = "freebsd"))]
include!("bindings.rs");

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
mod pipe;
#[cfg(target_os = "freebsd")]
pub use pipe::{NativePipe, create_pipe};
#[cfg(target_os = "freebsd")]
mod freebsd;
#[cfg(target_os = "freebsd")]
pub use freebsd::close_owned_fd;
#[cfg(target_os = "freebsd")]
mod realpath;
#[cfg(all(test, target_os = "freebsd"))]
mod test_support;

mod native_failure;
pub(crate) use native_failure::NativeError;

pub(crate) type NativeResult<T> = std::result::Result<T, NativeError>;

pub(crate) fn native_error(code: impl Into<String>, message: impl ToString) -> NativeError {
    NativeError { status: code.into(), reason: message.to_string(), errno: None }
}

pub(crate) fn into_napi<T>(env: napi::Env, result: NativeResult<T>) -> napi::Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(native_failure::to_napi_error(env, error)?),
    }
}
