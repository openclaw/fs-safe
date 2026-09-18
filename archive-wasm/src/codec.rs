use std::cell::RefCell;
use crate::{bzip2, zstd};

const BUFFER_SIZE: usize = 65536;

pub struct Step {
    pub consumed: usize,
    pub produced: usize,
    pub finished: bool,
}

enum Decoder {
    Bzip2(bzip2::Decoder),
    Zstd(zstd::Decoder),
}

impl Decoder {
    fn reset(&mut self) -> Result<(), &'static str> {
        match self {
            Self::Bzip2(decoder) => { *decoder = bzip2::Decoder::new()?; Ok(()) }
            Self::Zstd(decoder) => decoder.reset(),
        }
    }
    fn push(&mut self, input: &[u8], output: &mut [u8]) -> Result<Step, &'static str> {
        match self {
            Self::Bzip2(decoder) => decoder.push(input, output),
            Self::Zstd(decoder) => decoder.push(input, output),
        }
    }
}

struct Scratch {
    input: [u8; BUFFER_SIZE],
    output: [u8; BUFFER_SIZE],
}

struct State {
    decoder: Option<Decoder>,
    boundary: bool,
    consumed: usize,
    produced: usize,
    error: &'static str,
}

impl State {
    fn clear(&mut self) {
        self.decoder = None;
        self.boundary = false;
        self.consumed = 0;
        self.produced = 0;
        self.error = "";
    }
    fn fail(&mut self, error: &'static str) -> i32 {
        self.clear();
        self.error = error;
        -1
    }
}

thread_local! {
    // Keep zeroed scratch separate from nonzero decoder metadata so it stays in BSS.
    static SCRATCH: RefCell<Scratch> = const { RefCell::new(Scratch {
        input: [0; BUFFER_SIZE], output: [0; BUFFER_SIZE],
    }) };
    static STATE: RefCell<State> = const { RefCell::new(State {
        decoder: None,
        boundary: false, consumed: 0, produced: 0, error: "",
    }) };
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_input_ptr() -> usize { SCRATCH.with_borrow(|scratch| scratch.input.as_ptr() as usize) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_output_ptr() -> usize { SCRATCH.with_borrow(|scratch| scratch.output.as_ptr() as usize) }

#[unsafe(no_mangle)]
pub extern "C" fn codec_init(kind: u32) -> i32 {
    STATE.with_borrow_mut(|state| {
        state.clear();
        let decoder = match kind {
            1 => bzip2::Decoder::new().map(Decoder::Bzip2),
            2 => zstd::Decoder::new().map(Decoder::Zstd),
            _ => Err("unknown archive codec"),
        };
        match decoder {
            Ok(decoder) => { state.decoder = Some(decoder); 0 }
            Err(error) => state.fail(error),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_push(length: usize) -> i32 {
    STATE.with_borrow_mut(|state| {
        state.consumed = 0;
        state.produced = 0;
        if length > BUFFER_SIZE { return state.fail("invalid archive codec input length"); }
        if state.decoder.is_none() { return -1; }
        if length == 0 && state.boundary { return 1; }
        let previous_boundary = state.boundary;
        let decoder = state.decoder.as_mut().expect("active decoder");
        if previous_boundary && let Err(error) = decoder.reset() { return state.fail(error); }
        let result = SCRATCH.with_borrow_mut(|scratch| {
            let Scratch { input, output } = scratch;
            decoder.push(&input[..length], output)
        });
        match result {
            Ok(step) => {
                if length > 0 && step.consumed == 0 && step.produced == 0
                    && !(step.finished && !previous_boundary) {
                    return state.fail("archive codec made no progress");
                }
                state.consumed = step.consumed;
                state.produced = step.produced;
                state.boundary = step.finished;
                i32::from(step.finished)
            }
            Err(error) => state.fail(error),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_finish() -> i32 {
    STATE.with_borrow_mut(|state| {
        if !state.error.is_empty() { return -1; }
        if state.decoder.is_none() || !state.boundary { return state.fail("incomplete compressed stream"); }
        state.clear();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn codec_consumed() -> usize { STATE.with_borrow(|state| state.consumed) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_produced() -> usize { STATE.with_borrow(|state| state.produced) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_error_ptr() -> usize { STATE.with_borrow(|state| state.error.as_ptr() as usize) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_error_len() -> usize { STATE.with_borrow(|state| state.error.len()) }
#[unsafe(no_mangle)]
pub extern "C" fn codec_dispose() { STATE.with_borrow_mut(State::clear); }
