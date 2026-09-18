use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};
use std::io::{Cursor, Read};

use crate::codecs::Step;

const MAX_BLOCK: usize = 128 * 1024;
// Matches the default streaming libzstd window limit, before any allocation.
const MAX_WINDOW: u64 = 128 * 1024 * 1024;

enum Phase {
    Header,
    Block { checksum: bool },
    Drain,
    Skip(u32),
}

pub struct Decoder {
    decoder: FrameDecoder,
    phase: Phase,
    pending: Vec<u8>,
    saw_frame: bool,
    expected_size: Option<u64>,
    frame_output: u64,
    block_max: usize,
}

fn fill(pending: &mut Vec<u8>, size: usize, input: &[u8], used: &mut usize, eof: bool) -> Result<bool, String> {
    if pending.len() >= size { return Ok(true); }
    let count = (size - pending.len()).min(input.len() - *used);
    pending.extend_from_slice(&input[*used..*used + count]);
    *used += count;
    if pending.len() == size { return Ok(true); }
    if eof { return Err("truncated zstd frame".into()); }
    Ok(false)
}

impl Decoder {
    pub fn new() -> Self {
        let mut decoder = FrameDecoder::new();
        decoder.set_max_window_size(MAX_WINDOW);
        Self { decoder, phase: Phase::Header, pending: Vec::new(), saw_frame: false,
            expected_size: None, frame_output: 0, block_max: MAX_BLOCK }
    }

    // Admit one complete bounded block per step. The low-level decoder's
    // slice API can consume partial checksums; explicit boundaries avoid that.
    pub fn step(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Result<Step, String> {
        let mut used = 0;
        if self.decoder.can_collect() > 0 {
            let written = self.decoder.read(output).map_err(|e| e.to_string())?;
            self.frame_output += written as u64;
            return Ok(Step::progress(0, written));
        }
        match self.phase {
            Phase::Drain => {
                if self.decoder.get_checksum_from_data().is_some_and(|crc|
                    Some(crc) != self.decoder.get_calculated_checksum()) {
                    return Err("zstd checksum mismatch".into());
                }
                if self.expected_size.is_some_and(|size| size != self.frame_output) {
                    return Err("zstd frame content size mismatch".into());
                }
                self.saw_frame = true;
                self.phase = Phase::Header;
            }
            Phase::Skip(remaining) => {
                used = input.len().min(remaining as usize);
                let remaining = remaining - used as u32;
                if remaining == 0 {
                    self.saw_frame = true;
                    self.phase = Phase::Header;
                } else {
                    if eof { return Err("truncated zstd skippable frame".into()); }
                    self.phase = Phase::Skip(remaining);
                    return Ok(Step::input(used));
                }
            }
            Phase::Header => {
                if eof && input.is_empty() && self.pending.is_empty() && self.saw_frame {
                    return Ok(Step::end());
                }
                if !fill(&mut self.pending, 4, input, &mut used, eof)? { return Ok(Step::input(used)); }
                let magic = u32::from_le_bytes(self.pending[..4].try_into().unwrap());
                if magic & !15 == 0x184d2a50 {
                    if !fill(&mut self.pending, 8, input, &mut used, eof)? { return Ok(Step::input(used)); }
                    self.phase = Phase::Skip(u32::from_le_bytes(self.pending[4..8].try_into().unwrap()));
                    self.pending.clear();
                    return Ok(Step::progress(used, 0));
                }
                if magic != 0xfd2fb528 { return Err("invalid zstd frame magic".into()); }
                if !fill(&mut self.pending, 5, input, &mut used, eof)? { return Ok(Step::input(used)); }
                let descriptor = self.pending[4];
                if descriptor & 8 != 0 { return Err("reserved zstd frame descriptor bit".into()); }
                let single = descriptor & 32 != 0;
                let size_bytes = match descriptor >> 6 { 0 => usize::from(single), 1 => 2, 2 => 4, _ => 8 };
                let dict_bytes = [0, 1, 2, 4][(descriptor & 3) as usize];
                let header_size = 5 + usize::from(!single) + dict_bytes + size_bytes;
                if !fill(&mut self.pending, header_size, input, &mut used, eof)? { return Ok(Step::input(used)); }
                self.decoder.init(self.pending.as_slice()).map_err(|e| e.to_string())?;
                self.expected_size = if size_bytes == 0 { None } else { Some(self.decoder.content_size()) };
                let window = if single { self.decoder.content_size() } else {
                    let descriptor = self.pending[5];
                    let base = 1_u64 << (10 + (descriptor >> 3));
                    base + base / 8 * u64::from(descriptor & 7)
                };
                self.block_max = window.min(MAX_BLOCK as u64) as usize;
                self.frame_output = 0;
                self.phase = Phase::Block { checksum: descriptor & 4 != 0 };
                self.pending.clear();
            }
            Phase::Block { checksum } => {
                if !fill(&mut self.pending, 3, input, &mut used, eof)? { return Ok(Step::input(used)); }
                let header = u32::from_le_bytes([self.pending[0], self.pending[1], self.pending[2], 0]);
                let size = (header >> 3) as usize;
                if size > self.block_max { return Err("zstd block exceeds frame maximum size".into()); }
                let body_size = match (header >> 1) & 3 {
                    0 | 2 => size,
                    1 => 1,
                    _ => return Err("invalid zstd block type".into()),
                };
                let last = header & 1 != 0;
                let record_size = 3 + body_size + if last && checksum { 4 } else { 0 };
                if !fill(&mut self.pending, record_size, input, &mut used, eof)? { return Ok(Step::input(used)); }
                let mut source = Cursor::new(self.pending.as_slice());
                self.decoder.decode_blocks(&mut source, BlockDecodingStrategy::UptoBlocks(1))
                    .map_err(|e| e.to_string())?;
                if source.position() != record_size as u64 || self.decoder.is_finished() != last {
                    return Err("invalid zstd block boundary".into());
                }
                self.pending.clear();
                if last { self.phase = Phase::Drain; }
            }
        }
        Ok(Step::progress(used, 0))
    }
}
