use std::{fs, io::Write, path::{Path, PathBuf}};

fn tar(payload: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 512];
    header[..9].copy_from_slice(b"value.txt");
    header[100..108].copy_from_slice(b"0000600\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(format!("{:011o}\0", payload.len()).as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|value| *value as u32).sum();
    header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    let mut result = header.to_vec();
    result.extend_from_slice(payload);
    result.resize(result.len().div_ceil(512) * 512 + 1024, 0);
    result
}

fn encode(kind: &str, bytes: &[u8]) -> Vec<u8> {
    if kind == "bzip2" {
        let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::best());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    } else {
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        encoder.include_checksum(true).unwrap();
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
}

fn skip(bytes: &[u8]) -> Vec<u8> {
    let mut frame = 0x184d2a50u32.to_le_bytes().to_vec();
    frame.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    frame.extend_from_slice(bytes);
    frame
}

fn save(dir: &Path, rows: &mut String, kind: &str, label: &str, encoded: &[u8], decoded: Option<&[u8]>, tar_ok: bool) {
    let key = format!("{kind}-{label}");
    fs::write(dir.join(format!("{key}.encoded")), encoded).unwrap();
    if let Some(decoded) = decoded { fs::write(dir.join(format!("{key}.decoded")), decoded).unwrap(); }
    rows.push_str(&format!("{key}\t{kind}\t{}\t{tar_ok}\n", decoded.is_some()));
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("fixture directory"));
    fs::create_dir_all(&dir).unwrap();
    let small = tar(b"actual codec and complete container checks\n");
    let zeros = tar(&vec![0; 8 * 1024 * 1024 + 1]);
    let mut seed = 0xd58a4e23u32;
    let random: Vec<u8> = (0..262145).map(|_| { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed as u8 }).collect();
    let large = tar(&random);
    let mut rows = String::new();
    for kind in ["bzip2", "zstd"] {
        let encoded = encode(kind, &small);
        let empty = encode(kind, &[]);
        save(&dir, &mut rows, kind, "valid-checksummed", &encoded, Some(&small), true);
        for split in [1, 511, 512, 513] {
            save(&dir, &mut rows, kind, &format!("small-prefix-{split}"), &encode(kind, &small[..split]), Some(&small[..split]), false);
            save(&dir, &mut rows, kind, &format!("small-rest-{split}"), &encode(kind, &small[split..]), Some(&small[split..]), false);
        }
        save(&dir, &mut rows, kind, "zero-expansion-8m", &encode(kind, &zeros), Some(&zeros), true);
        save(&dir, &mut rows, kind, "incompressible-cross-inbox", &encode(kind, &large), Some(&large), true);
        save(&dir, &mut rows, kind, "empty-frame", &empty, Some(&[]), false);
        for split in [1, 511, 512, 65535, 65536, 65537] {
            let bytes = [&encode(kind, &large[..split])[..], &empty, &encode(kind, &large[split..]), &empty].concat();
            save(&dir, &mut rows, kind, &format!("split-{split}-empty-members"), &bytes, Some(&large), true);
        }
        let twice = [&encoded[..], &encoded].concat();
        let twice_decoded = [&small[..], &small].concat();
        save(&dir, &mut rows, kind, "second-tar", &twice, Some(&twice_decoded), false);
        let pad = vec![0u8; 65537];
        let padded = [&encoded[..], &encode(kind, &pad)].concat();
        let pad_decoded = [&small[..], &pad].concat();
        save(&dir, &mut rows, kind, "separate-zero-padding", &padded, Some(&pad_decoded), true);
        for n in [1, 9, encoded.len() / 2] {
            save(&dir, &mut rows, kind, &format!("truncated-{n}"), &encoded[..encoded.len() - n], None, false);
        }
        let mut corrupt = encoded.clone();
        let corrupt_at = if kind == "bzip2" { 10 } else { corrupt.len() - 1 };
        corrupt[corrupt_at] ^= 0x80;
        save(&dir, &mut rows, kind, "corrupt-checksum", &corrupt, None, false);
        for (name, junk) in [("zero-junk", vec![0; 20]), ("nonzero-junk", b"unexpected physical trailer".to_vec())] {
            save(&dir, &mut rows, kind, name, &[&encoded[..], &junk].concat(), None, false);
        }
        for n in [1, 3, 10, encoded.len() - 1] {
            save(&dir, &mut rows, kind, &format!("partial-next-{n}"), &[&encoded[..], &encoded[..n]].concat(), None, false);
        }
        save(&dir, &mut rows, kind, "bad-final-checksum", &[&encoded[..], &corrupt].concat(), None, false);
        let mut corrupt_empty = empty.clone();
        let corrupt_at = corrupt_empty.len() - 2;
        corrupt_empty[corrupt_at] ^= 0x80;
        save(&dir, &mut rows, kind, "bad-final-empty-checksum", &[&encoded[..], &corrupt_empty].concat(), None, false);
        if kind == "zstd" {
            let mut dictionary = encoded.clone();
            assert_eq!(dictionary[4] & 3, 0);
            let dictionary_offset = if dictionary[4] & 0x20 == 0 { 6 } else { 5 };
            dictionary[4] |= 1;
            dictionary.insert(dictionary_offset, 7);
            save(&dir, &mut rows, kind, "dictionary-required", &dictionary, None, false);
            save(&dir, &mut rows, kind, "later-dictionary-required", &[&encoded[..], &dictionary].concat(), None, false);
            let rle = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38, 0x03, 0x00, 0x10, 0x00];
            save(&dir, &mut rows, kind, "rle-block", &rle, Some(&vec![0; 131072]), true);
            let skippable = skip(b"skipped user frame");
            let input = [&skippable[..], &encoded, &skippable, &empty, &skippable].concat();
            save(&dir, &mut rows, kind, "skippable-before-between-after", &input, Some(&small), true);
            for n in [1, 7, 8, skippable.len() - 1] {
                save(&dir, &mut rows, kind, &format!("skippable-truncated-{n}"), &[&encoded[..], &skippable[..n]].concat(), None, false);
            }
        }
    }
    fs::write(dir.join("fixtures.tsv"), rows).unwrap();
}
