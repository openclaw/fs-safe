use std::{ffi::{c_int, c_void}, mem, ptr::{self, NonNull}};
use libbz2_rs_sys as sys;
use crate::{allocation, codec::Step};

pub struct Decoder(NonNull<sys::bz_stream>);

unsafe extern "C" fn allocate(opaque: *mut c_void, count: c_int, size: c_int) -> *mut c_void {
    let Some(bytes) = usize::try_from(count).ok().zip(usize::try_from(size).ok())
        .and_then(|(count, size)| count.checked_mul(size)) else { return ptr::null_mut(); };
    unsafe { allocation::allocate(opaque, bytes) }
}

impl Decoder {
    pub fn new() -> Result<Self, &'static str> {
        let pointer = unsafe { allocation::allocate(ptr::null_mut(), mem::size_of::<sys::bz_stream>()) };
        let mut decoder = Self(NonNull::new(pointer.cast()).ok_or("bzip2 stream allocation failed")?);
        // bz_stream must remain at a stable address until its paired End call.
        unsafe { decoder.0.as_ptr().write(mem::zeroed()); }
        let stream = unsafe { decoder.0.as_mut() };
        stream.bzalloc = Some(allocate);
        stream.bzfree = Some(allocation::release);
        let code = unsafe { sys::BZ2_bzDecompressInit(stream, 0, 0) };
        if code != sys::BZ_OK { return Err(error(code)); }
        Ok(decoder)
    }

    pub fn push(&mut self, input: &[u8], output: &mut [u8]) -> Result<Step, &'static str> {
        let stream = unsafe { self.0.as_mut() };
        stream.next_in = input.as_ptr().cast();
        stream.avail_in = input.len() as u32;
        stream.next_out = output.as_mut_ptr().cast();
        stream.avail_out = output.len() as u32;
        let code = unsafe { sys::BZ2_bzDecompress(stream) };
        let step = Step {
            consumed: input.len() - stream.avail_in as usize,
            produced: output.len() - stream.avail_out as usize,
            finished: code == sys::BZ_STREAM_END,
        };
        if code != sys::BZ_OK && code != sys::BZ_STREAM_END { return Err(error(code)); }
        Ok(step)
    }
}

fn error(code: c_int) -> &'static str {
    match code {
        sys::BZ_MEM_ERROR => "bzip2 allocation failed",
        sys::BZ_DATA_ERROR => "invalid bzip2 data or checksum",
        sys::BZ_DATA_ERROR_MAGIC => "invalid bzip2 header",
        sys::BZ_SEQUENCE_ERROR => "invalid bzip2 decoder state",
        _ => "invalid bzip2 stream",
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            if !self.0.as_ref().state.is_null() { sys::BZ2_bzDecompressEnd(self.0.as_ptr()); }
            allocation::release(ptr::null_mut(), self.0.as_ptr().cast());
        }
    }
}
