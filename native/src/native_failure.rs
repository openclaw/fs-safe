use napi::{Env, Error, Property, Result};
use napi::bindgen_prelude::{JsObjectValue, JsValue};

/// Native diagnostics stay attached while an error crosses workers or changes classification.
#[derive(Debug)]
pub struct NativeError {
    pub status: String,
    pub reason: String,
    pub errno: Option<u32>,
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
    value.define_properties(&properties)?;
    Ok(Error::from(value.to_unknown()))
}
