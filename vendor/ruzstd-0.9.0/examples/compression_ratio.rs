use std::time::Instant;

use ruzstd::encoding::{compress_to_vec, CompressionLevel};

const ITERATIONS: usize = 50;

fn main() {
    let fixtures = [
        ("zeros_128k", zeros(128 * 1024)),
        ("repeated_text_128k", repeated_text(128 * 1024)),
        ("xorshift_8k", xorshift(8 * 1024)),
        ("xorshift_64k", xorshift(64 * 1024)),
        ("xorshift_128k", xorshift(128 * 1024)),
        ("xorshift_256k", xorshift(256 * 1024)),
    ];

    println!("fixture,input_bytes,compressed_bytes,avg_nanos");
    for (name, data) in fixtures {
        let mut compressed = Vec::new();
        let started = Instant::now();
        for _ in 0..ITERATIONS {
            compressed = compress_to_vec(data.as_slice(), CompressionLevel::Fastest);
        }
        let avg_nanos = started.elapsed().as_nanos() / ITERATIONS as u128;
        println!("{name},{},{},{avg_nanos}", data.len(), compressed.len());
    }
}

fn zeros(len: usize) -> Vec<u8> {
    vec![0; len]
}

fn repeated_text(len: usize) -> Vec<u8> {
    let phrase = b"systemd-journald.service After=systemd-journald-dev-log.socket\n";
    phrase.iter().copied().cycle().take(len).collect()
}

fn xorshift(len: usize) -> Vec<u8> {
    let mut state = 0x1234_5678_9ABC_DEF0u64;
    let mut data = Vec::with_capacity(len);
    while data.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        data.extend_from_slice(&state.to_le_bytes());
    }
    data.truncate(len);
    data
}
