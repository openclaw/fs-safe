use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::{AbortSignal, Task, ToNapiValue, TypeName};
use napi::{Env, Error, JsError, Result, Status};

use crate::NativeResult;

// Plain native workers settle their original error on the JS thread. Resource
// handoffs and workers with cancellation-time resolution retain their own Task.
pub struct NativeTask<T> {
    operation: Option<Box<dyn FnOnce() -> NativeResult<T> + Send>>,
}

impl<T> NativeTask<T> {
    pub(crate) fn new(operation: impl FnOnce() -> NativeResult<T> + Send + 'static) -> Self {
        Self {
            operation: Some(Box::new(operation)),
        }
    }
}

impl<T: Send + ToNapiValue + TypeName + 'static> Task for NativeTask<T> {
    type Output = NativeResult<T>;
    type JsValue = T;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.operation.take().expect("native task computes once")())
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<T> {
        output.map_err(|error| Error::from(JsError::from(error).into_unknown(env)))
    }
}

pub(crate) fn cancellation(signal: Option<&AbortSignal>) -> Arc<AtomicBool> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = signal {
        let callback = Arc::clone(&cancelled);
        signal.on_abort(move || callback.store(true, Ordering::Relaxed));
    }
    cancelled
}

pub(crate) fn checked_max_bytes(value: Option<f64>) -> Result<u64> {
    match value {
        Some(value)
            if value.is_finite()
                && (0.0..=crate::tar_meter::MAX_SAFE_INTEGER as f64).contains(&value)
                && value.fract() == 0.0 =>
        {
            Ok(value as u64)
        }
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            "maxBytes must be a non-negative safe integer",
        )),
        None => Ok(u64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_retains_native_error_details_until_js_settlement() {
        let mut task = NativeTask::<()>::new(|| {
            Err(crate::native_error("ENOSPC", "owned operation failed; cleanup failed"))
        });
        let error = task.compute().unwrap().unwrap_err();
        assert_eq!(error.status, "ENOSPC");
        assert_eq!(error.reason, "owned operation failed; cleanup failed");
    }

    #[test]
    fn byte_limits_preserve_absence_and_exact_integer_bounds() {
        assert_eq!(checked_max_bytes(None).unwrap(), u64::MAX);
        for value in [0, 1, crate::tar_meter::MAX_SAFE_INTEGER] {
            assert_eq!(checked_max_bytes(Some(value as f64)).unwrap(), value);
        }
        for value in [f64::NAN, f64::INFINITY, -1.0, 0.5, 9_007_199_254_740_992.0] {
            let error = checked_max_bytes(Some(value)).unwrap_err();
            assert_eq!(error.status, Status::InvalidArg);
            assert_eq!(error.reason, "maxBytes must be a non-negative safe integer");
        }
    }
}
