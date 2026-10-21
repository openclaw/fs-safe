use napi::{Env, Error, Property, Result};
use napi::bindgen_prelude::{JsObjectValue, JsValue};

/// Native diagnostics stay attached while an error crosses workers or changes classification.
#[derive(Debug)]
pub struct NativeError {
    pub status: String,
    pub reason: String,
    pub errno: Option<u32>,
    pub open: Option<OpenFailure>,
}

#[derive(Clone, Debug)]
pub struct OpenFailure {
    pub path: String,
    pub operation: &'static str,
    pub flags: i32,
}

impl NativeError {
    pub(crate) fn with_open_context(mut self, path: &str, operation: &'static str, flags: i32) -> Self {
        if self.status == "EROFS" {
            let escaped: String = path.chars().map(|ch| match ch {
                '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' => format!("\\u{:04x}", ch as u32),
                _ => ch.to_string(),
            }).collect();
            self.reason = format!("EROFS: read-only filesystem, {operation} '{escaped}' (flags {flags})");
            self.open = Some(OpenFailure { path: path.into(), operation, flags });
        }
        self
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}, {}", self.status, self.reason)
    }
}

impl std::error::Error for NativeError {}

pub(crate) fn to_napi_error(env: Env, error: NativeError) -> Result<Error> {
    let mut value = env.create_error(Error::from_reason(error.reason))?;
    let mut properties = vec![Property::new().with_utf8_name("code")?.with_napi_value(&env, error.status)?];
    if let Some(errno) = error.errno {
        properties.push(Property::new().with_utf8_name("errno")?.with_napi_value(&env, errno)?);
    }
    if let Some(open) = error.open {
        properties.push(Property::new().with_utf8_name("path")?.with_napi_value(&env, open.path)?);
        properties.push(Property::new().with_utf8_name("operation")?.with_napi_value(&env, open.operation)?);
        properties.push(Property::new().with_utf8_name("flags")?.with_napi_value(&env, open.flags)?);
    }
    value.define_properties(&properties)?;
    Ok(Error::from(value.to_unknown()))
}

#[cfg(test)]
mod tests {
    use crate::native_error;

    #[test]
    fn read_only_open_context_retains_errno_and_escapes_display_path() {
        let mut error = native_error("EROFS", "original");
        error.errno = Some(30);
        let error = error.with_open_context("state\n\u{9b}\u{2028}\u{2029}", "openBeneath", 193);
        assert_eq!(error.status, "EROFS");
        assert_eq!(error.errno, Some(30));
        assert_eq!(error.reason, "EROFS: read-only filesystem, openBeneath 'state\\u000a\\u009b\\u2028\\u2029' (flags 193)");
        let open = error.open.unwrap();
        assert_eq!(open.path, "state\n\u{9b}\u{2028}\u{2029}");
        assert_eq!(open.operation, "openBeneath");
        assert_eq!(open.flags, 193);
    }

    #[test]
    fn other_open_errors_keep_their_original_diagnostics() {
        let error = native_error("EPERM", "denied").with_open_context("state", "openBeneath", 193);
        assert_eq!(error.reason, "denied");
        assert!(error.open.is_none());
    }
}
