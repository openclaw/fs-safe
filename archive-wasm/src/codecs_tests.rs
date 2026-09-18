use super::{codec_dispose, codec_init, codec_step, STATE};

fn hex(value: &str) -> Vec<u8> {
    value.as_bytes().chunks_exact(2).map(|pair| {
        u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
    }).collect()
}

fn frame(blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = hex("28b52ffd0000"); // No content size; 1 KiB history window.
    for block in blocks { bytes.extend_from_slice(block); }
    bytes
}

fn raw(size: usize, last: bool) -> Vec<u8> {
    let header = ((size as u32) << 3) | u32::from(last);
    let mut bytes = header.to_le_bytes()[..3].to_vec();
    bytes.resize(3 + size, b'x');
    bytes
}

fn decode(input: &[u8], chunk_size: usize) -> Result<Vec<u8>, String> {
    assert_eq!(codec_init(2, 1_000_000.0), 0);
    let result = (|| {
        let mut output = Vec::new();
        for part in input.chunks(chunk_size).chain(std::iter::once(&[][..])) {
            STATE.with_borrow_mut(|s| s.input[..part.len()].copy_from_slice(part));
            let mut offset = 0;
            loop {
                let code = codec_step(offset, part.len() - offset, u32::from(part.is_empty()));
                if code < 0 { return Err(STATE.with_borrow(|s| s.error.clone())); }
                STATE.with_borrow(|s| {
                    offset += s.used;
                    output.extend_from_slice(&s.output[..s.written]);
                });
                if code != 0 {
                    assert_eq!(offset, part.len());
                    assert_eq!(code == 2, part.is_empty());
                    break;
                }
            }
        }
        Ok(output)
    })();
    codec_dispose();
    result
}

#[test]
fn small_windows_accept_valid_multiblock_output_larger_than_history() {
    // Node/libzstd: 5,000 'a' bytes with windowLog=10 and contentSizeFlag=0.
    let compressed = hex("28b52ffd00004c00001061610100fb2b8005022000610220006102200061431c0061");
    for chunk in [1, 7, 65536] {
        assert_eq!(decode(&compressed, chunk).unwrap(), vec![b'a'; 5000]);
        assert_eq!(decode(&frame(&[raw(700, false), raw(900, false), raw(1000, true)]), chunk).unwrap(), vec![b'x'; 2600]);
    }
}

#[test]
fn rejects_expansion_in_every_block_position_before_history_growth() {
    // Independently compressed 5,000 'a' bytes; the block is retained inside
    // a deliberately invalid 1 KiB-window frame, with no declared frame size.
    let last = hex("4d0000106161010083d3032c");
    let mut middle = last.clone(); middle[0] &= !1;
    for bytes in [
        frame(&[last.clone()]),
        frame(&[middle.clone(), raw(0, true)]),
        frame(&[raw(50, false), last.clone()]),
        frame(&[raw(1024, false), last]),
        frame(&[raw(50, false), middle, raw(50, true)]),
        // A compressed block with 1,500 regenerated RLE literals and no sequences.
        frame(&[hex("2d0000cd5d006100")]),
        // 342 minimum-length sequences already exceed the 1 KiB block budget.
        frame(&[hex("2d00000081560001")]),
    ] {
        for chunk in [1, 7, 65536] {
            let error = decode(&bytes, chunk).unwrap_err();
            assert!(error.contains("BlockSizeExceedsLimit") && error.contains("limit: 1024"), "{error}");
        }
    }
}

#[test]
fn decoded_block_limit_accepts_exact_boundary_and_rejects_one_more() {
    // Blocks from Node/libzstd, retaining exact compressed bytes.
    let exact = frame(&[hex("4d00001061610100fb2b8005")]);
    let excess = frame(&[hex("4d00001061610100fc2b8005")]);
    assert_eq!(decode(&exact, 1).unwrap(), vec![b'a'; 1024]);
    let error = decode(&excess, 1).unwrap_err();
    assert!(error.contains("BlockSizeExceedsLimit") && error.contains("limit: 1024"), "{error}");
}

fn huffman_zero_block(counts: &[usize], regenerated: usize, treeless: bool, last: bool) -> Vec<u8> {
    let streams: Vec<Vec<u8>> = counts.iter().map(|count| {
        let mut stream = vec![0; count / 8 + 1];
        *stream.last_mut().unwrap() = 1 << (count % 8);
        stream
    }).collect();
    let four = counts.len() == 4;
    // Direct two-symbol Huffman table: zero and one each consume one bit.
    let mut literals = if treeless { Vec::new() } else { vec![0x80, 0x10] };
    if four {
        for stream in &streams[..3] { literals.extend_from_slice(&(stream.len() as u16).to_le_bytes()); }
    }
    for stream in streams { literals.extend(stream); }
    let header = (if treeless { 3 } else { 2 }) | (if four { 8 } else { 0 })
        | ((regenerated as u32) << 4) | ((literals.len() as u32) << (if four { 18 } else { 14 }));
    let mut body = header.to_le_bytes()[..if four { 4 } else { 3 }].to_vec();
    body.extend(literals); body.push(0); // No sequences: emit every literal.
    let block_header = ((body.len() as u32) << 3) | 4 | u32::from(last);
    let mut block = block_header.to_le_bytes()[..3].to_vec(); block.extend(body); block
}

#[test]
fn huffman_stream_lengths_preserve_remainders_and_reject_redistribution() {
    for treeless in [false, true] {
        let prefix = if treeless { vec![huffman_zero_block(&[8, 8, 8, 8], 32, false, false)] } else { vec![] };
        for chunk in [1, 7, 65536] {
            for remainder in 0..4 {
                let mut blocks = prefix.clone();
                blocks.push(huffman_zero_block(&[64, 64, 64, 64 - remainder], 256 - remainder, treeless, true));
                assert_eq!(decode(&frame(&blocks), chunk).unwrap(), vec![0; 256 - remainder + if treeless { 32 } else { 0 }]);
            }
            for stream in 0..4 {
                for shift in [-1_i32, 1] {
                    let mut counts = [64; 4];
                    counts[stream] = (counts[stream] as i32 + shift) as usize;
                    counts[(stream + 1) % 4] = (counts[(stream + 1) % 4] as i32 - shift) as usize;
                    let mut blocks = prefix.clone(); blocks.push(huffman_zero_block(&counts, 256, treeless, true));
                    let error = decode(&frame(&blocks), chunk).unwrap_err();
                    assert!(error.contains("archive-header-invalid"), "{error}");
                }
            }
        }
    }
}

#[test]
fn huffman_streams_reject_impossible_remainders_and_unbounded_or_partial_symbols() {
    for chunk in [1, 7, 65536] {
        for counts in [[1, 0, 0, 0], [1, 1, 0, 0], [2, 1, 1, 1]] {
            let block = huffman_zero_block(&counts, counts.iter().sum(), false, true);
            let error = decode(&frame(&[block]), chunk).unwrap_err();
            assert!(error.contains("DecodedLiteralCountMismatch"), "{error}");
        }
        // Explicit weights 81 11 require two bits for zero. 04 provides 00;
        // 02 truncates the code to one zero bit plus the end marker.
        assert_eq!(decode(&frame(&[hex("3d000012c00081110400")]), chunk).unwrap(), vec![0]);
        assert_eq!(decode(&frame(&[huffman_zero_block(&[64], 64, false, true)]), chunk).unwrap(), vec![0; 64]);
        for block in [
            hex("3d000012c00081110200"),
            huffman_zero_block(&[4096], 1, false, true),
            huffman_zero_block(&[63], 64, false, true),
        ] {
            let error = decode(&frame(&[block]), chunk).unwrap_err();
            assert!(error.contains("archive-header-invalid"), "{error}");
        }
    }
}
