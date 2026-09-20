use napi::bindgen_prelude::AsyncTask;
use napi::Result;
use napi_derive::napi;

use crate::{NativeResult, platform, validate_relative_path};
use crate::task::NativeTask;

#[napi(js_name = "ownedTreeRemovalAvailable")]
pub fn owned_tree_removal_available(parent_fd: i32) -> bool {
    platform::owned_tree_removal_available(parent_fd)
}

#[napi(object)]
pub struct NativeOwnedTreeRemovalResult {
    pub outcome: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

fn removal_result(result: NativeResult<String>) -> NativeOwnedTreeRemovalResult {
    match result {
        Ok(outcome) => NativeOwnedTreeRemovalResult {
            outcome: Some(outcome),
            error_code: None,
            error_message: None,
        },
        Err(error) => NativeOwnedTreeRemovalResult {
            outcome: None,
            error_code: Some(error.status),
            error_message: Some(error.reason),
        },
    }
}

#[napi(js_name = "removeOwnedTree")]
pub fn remove_owned_tree(
    parent_fd: i32,
    basename: String,
    directory_fd: i32,
) -> Result<AsyncTask<NativeTask<NativeOwnedTreeRemovalResult>>> {
    validate_relative_path(&basename, false)
        .map_err(|error| napi::Error::new(napi::Status::InvalidArg, error.reason))?;
    Ok(AsyncTask::new(NativeTask::new(move || {
        Ok(removal_result(platform::remove_owned_tree(parent_fd, &basename, directory_fd)))
    })))
}

#[napi(js_name = "removeOwnedTreeSync")]
pub fn remove_owned_tree_sync(
    parent_fd: i32,
    basename: String,
    directory_fd: i32,
) -> NativeOwnedTreeRemovalResult {
    removal_result(
        validate_relative_path(&basename, false).and_then(|()| {
            platform::remove_owned_tree(parent_fd, &basename, directory_fd)
        }),
    )
}
