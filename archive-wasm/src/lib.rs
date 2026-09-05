//! Private ABI. Each JavaScript parser owns a separate, import-free instance.
//! No caller-supplied pointer is dereferenced; only lengths into our fixed inbox.
use fs_safe_archive_core::{TarMetadataMeter, TarMeterLimits, TarMember};
use std::cell::RefCell;

struct State {
    input: [u8; 65536],
    parser: Option<TarMetadataMeter<()>>,
    member: Option<TarMember>,
    error: String,
}
thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State {
        input: [0; 65536], parser: None, member: None, error: String::new(),
    }) };
}

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> usize {
    STATE.with_borrow(|s| s.input.as_ptr() as usize)
}

fn limit(value: f64, max: u64) -> Option<u64> {
    if !value.is_finite() || value < 0.0 { None } else { Some(value.min(max as f64) as u64) }
}

#[unsafe(no_mangle)]
pub extern "C" fn init(entries: f64, metadata: f64, decoded: f64, manifest: f64, windows: u32) -> i32 {
    STATE.with_borrow_mut(|s| {
        s.parser = None;
        s.member = None;
        s.error.clear();
        if windows > 1 { return -1; }
        let Some((((entries, metadata), decoded), manifest)) = limit(entries, u32::MAX as u64)
            .zip(limit(metadata, 9_007_199_254_740_991))
            .zip(limit(decoded, 9_007_199_254_740_991))
            .zip(limit(manifest, 64 * 1024 * 1024)) else { return -1; };
        s.parser = Some(TarMetadataMeter::new((), TarMeterLimits {
            windows_paths: windows == 1, max_entries: entries as usize, max_meta_entry_bytes: metadata,
            max_decoded_bytes: decoded, max_manifest_bytes: manifest,
        }));
        s.member = None;
        s.error.clear();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn push(length: usize) -> i32 {
    STATE.with_borrow_mut(|s| {
        if length == 0 || length > s.input.len() || !s.error.is_empty() { return -1; }
        let Some(parser) = &mut s.parser else { return -1; };
        match parser.push(&s.input[..length]) {
            Ok(used) => { s.member = parser.take_member(); used as i32 }
            Err(error) => { s.error = error.to_string(); s.parser = None; -1 }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn finish() -> i32 {
    STATE.with_borrow_mut(|s| {
        let Some(parser) = s.parser.take() else { return -1; };
        match parser.finish() {
            Ok(()) => 0,
            Err(error) => { s.error = error.to_string(); -1 }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn dispose() {
    STATE.with_borrow_mut(|s| { s.parser = None; s.member = None; s.error.clear(); });
}

#[unsafe(no_mangle)]
pub extern "C" fn text_ptr() -> usize {
    STATE.with_borrow(|s| {
        if !s.error.is_empty() { s.error.as_ptr() as usize }
        else { s.member.as_ref().map_or(0, |m| m.path.as_ptr() as usize) }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn text_len() -> usize {
    STATE.with_borrow(|s| {
        if !s.error.is_empty() { s.error.len() }
        else { s.member.as_ref().map_or(0, |m| m.path.len()) }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn member_type() -> i32 {
    STATE.with_borrow(|s| s.member.as_ref().map_or(-1, |m| m.entry_type as i32))
}
#[unsafe(no_mangle)]
pub extern "C" fn member_size() -> f64 {
    STATE.with_borrow(|s| s.member.as_ref().map_or(0.0, |m| m.size as f64))
}
#[unsafe(no_mangle)]
pub extern "C" fn member_offset() -> f64 {
    STATE.with_borrow(|s| s.member.as_ref().map_or(0.0, |m| m.offset as f64))
}
#[unsafe(no_mangle)]
pub extern "C" fn member_mode() -> u32 {
    STATE.with_borrow(|s| s.member.as_ref().map_or(0, |m| m.mode))
}
