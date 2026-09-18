//! Isolated portable decoders. Every call consumes a bounded input window,
//! emits at most one output window, or advances one bounded container step.
use bzip2::{Decompress, Status};
use std::cell::RefCell;

const WINDOW: usize = 65536;

pub struct Step { used: usize, written: usize, code: i32 }
impl Step {
    pub fn progress(used: usize, written: usize) -> Self { Self { used, written, code: 0 } }
    pub fn input(used: usize) -> Self { Self { used, written: 0, code: 1 } }
    pub fn end() -> Self { Self { used: 0, written: 0, code: 2 } }
}

struct BzipDecoder { decoder: Decompress, boundary: bool, saw_member: bool }
impl BzipDecoder {
    fn new() -> Self { Self { decoder: Decompress::new(false), boundary: true, saw_member: false } }
    fn step(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Result<Step, String> {
        if self.boundary {
            if input.is_empty() {
                return if eof {
                    if self.saw_member { Ok(Step::end()) } else { Err("truncated bzip2 header".into()) }
                } else { Ok(Step::input(0)) };
            }
            self.decoder = Decompress::new(false);
            self.boundary = false;
        }
        let before_in = self.decoder.total_in();
        let before_out = self.decoder.total_out();
        let result = self.decoder.decompress(input, output).map_err(|e| e.to_string())?;
        let used = (self.decoder.total_in() - before_in) as usize;
        let written = (self.decoder.total_out() - before_out) as usize;
        if result == Status::MemNeeded { return Err("bzip2 decoder allocation failed".into()); }
        if result == Status::StreamEnd {
            self.boundary = true;
            self.saw_member = true;
        } else if used == 0 && written == 0 {
            return if eof { Err("truncated bzip2 stream".into()) } else { Ok(Step::input(0)) };
        }
        Ok(Step::progress(used, written))
    }
}

enum Decoder { Bzip(BzipDecoder), Zstd(crate::zstd::Decoder) }
struct State {
    input: [u8; WINDOW], output: [u8; WINDOW], decoder: Option<Decoder>,
    used: usize, written: usize, decoded: u64, limit: u64, error: String,
}
thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State {
        input: [0; WINDOW], output: [0; WINDOW], decoder: None,
        used: 0, written: 0, decoded: 0, limit: 0, error: String::new(),
    }) };
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_input_ptr() -> usize { STATE.with_borrow(|s| s.input.as_ptr() as usize) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_output_ptr() -> usize { STATE.with_borrow(|s| s.output.as_ptr() as usize) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_used() -> usize { STATE.with_borrow(|s| s.used) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_written() -> usize { STATE.with_borrow(|s| s.written) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_error_ptr() -> usize { STATE.with_borrow(|s| s.error.as_ptr() as usize) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_error_len() -> usize { STATE.with_borrow(|s| s.error.len()) }

#[unsafe(no_mangle)]
pub extern "C" fn codec_init(kind: u32, limit: f64) -> i32 {
    STATE.with_borrow_mut(|s| {
        s.decoder = None;
        s.error.clear();
        s.used = 0; s.written = 0; s.decoded = 0;
        let Some(limit) = crate::limit(limit, 9_007_199_254_740_991) else { return -1; };
        s.limit = limit;
        s.decoder = Some(match kind {
            1 => Decoder::Bzip(BzipDecoder::new()),
            2 => Decoder::Zstd(crate::zstd::Decoder::new()),
            _ => return -1,
        });
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_step(offset: usize, length: usize, eof: u32) -> i32 {
    STATE.with_borrow_mut(|s| {
        s.used = 0; s.written = 0;
        if offset > WINDOW || length > WINDOW - offset || eof > 1 || !s.error.is_empty() { return -1; }
        let Some(decoder) = &mut s.decoder else { return -1; };
        let output_size = (s.limit - s.decoded).saturating_add(1).min(WINDOW as u64) as usize;
        let result = match decoder {
            Decoder::Bzip(decoder) => decoder.step(&s.input[offset..offset + length], &mut s.output[..output_size], eof == 1),
            Decoder::Zstd(decoder) => decoder.step(&s.input[offset..offset + length], &mut s.output[..output_size], eof == 1),
        };
        match result {
            Ok(step) => {
                s.used = step.used;
                s.decoded += step.written as u64;
                if s.decoded > s.limit {
                    s.error = "archive-decoded-size-exceeds-limit".into();
                    s.decoder = None;
                    return -1;
                }
                s.written = step.written;
                step.code
            }
            Err(error) => { s.error = format!("archive-header-invalid:{error}"); s.decoder = None; -1 }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_dispose() {
    STATE.with_borrow_mut(|s| { s.decoder = None; s.error.clear(); s.used = 0; s.written = 0; });
}

#[cfg(test)]
#[path = "codecs_tests.rs"]
mod tests;
