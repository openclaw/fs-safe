use std::{ffi::CStr, ptr::{self, NonNull}};
use zstd_sys as sys;
use crate::{allocation, codec::Step};

pub struct Decoder(NonNull<sys::ZSTD_DCtx>);

fn result(code: usize) -> Result<usize, &'static str> {
    if unsafe { sys::ZSTD_isError(code) } == 0 { return Ok(code); }
    // zstd returns process-lifetime ASCII error strings, including allocation errors.
    let error = unsafe { CStr::from_ptr(sys::ZSTD_getErrorName(code)) };
    Err(error.to_str().unwrap_or("invalid zstd stream"))
}

impl Decoder {
    pub fn new() -> Result<Self, &'static str> {
        // The upstream WASM malloc shim does not check allocation failure.
        let context = unsafe { sys::ZSTD_createDCtx_advanced(sys::ZSTD_customMem {
            customAlloc: Some(allocation::allocate),
            customFree: Some(allocation::release),
            opaque: ptr::null_mut(),
        }) };
        let decoder = Self(NonNull::new(context).ok_or("zstd context allocation failed")?);
        result(unsafe { sys::ZSTD_initDStream(decoder.0.as_ptr()) })?;
        result(unsafe { sys::ZSTD_DCtx_loadDictionary(decoder.0.as_ptr(), ptr::null(), 0) })?;
        Ok(decoder)
    }

    pub fn reset(&mut self) -> Result<(), &'static str> {
        result(unsafe { sys::ZSTD_DCtx_reset(self.0.as_ptr(), sys::ZSTD_ResetDirective::ZSTD_reset_session_only) })?;
        Ok(())
    }

    pub fn push(&mut self, input: &[u8], output: &mut [u8]) -> Result<Step, &'static str> {
        let mut source = sys::ZSTD_inBuffer { src: input.as_ptr().cast(), size: input.len(), pos: 0 };
        let mut target = sys::ZSTD_outBuffer { dst: output.as_mut_ptr().cast(), size: output.len(), pos: 0 };
        let remaining = result(unsafe { sys::ZSTD_decompressStream(self.0.as_ptr(), &mut target, &mut source) })?;
        Ok(Step { consumed: source.pos, produced: target.pos, finished: remaining == 0 })
    }
}

impl Drop for Decoder {
    fn drop(&mut self) { unsafe { sys::ZSTD_freeDCtx(self.0.as_ptr()); } }
}
