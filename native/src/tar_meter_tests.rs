use super::*;
use std::io::Cursor;

pub(super) fn test_limits(max_meta_entry_bytes: u64) -> TarMeterLimits {
    TarMeterLimits {
        max_meta_entry_bytes,
        max_entries: 50_000,
        max_entry_bytes: 256 * 1024 * 1024,
        max_extracted_bytes: 512 * 1024 * 1024,
        max_decoded_bytes: 768 * 1024 * 1024,
    }
}

struct Chunked {
    inner: Cursor<Vec<u8>>,
    chunk: usize,
}

impl Read for Chunked {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let size = output.len().min(self.chunk);
        self.inner.read(&mut output[..size])
    }
}

fn record(key: &str, value: &[u8]) -> Vec<u8> {
    let payload = [format!(" {key}=").as_bytes(), value, b"\n"].concat();
    let mut length = payload.len() + 1;
    while length != length.to_string().len() + payload.len() {
        length = length.to_string().len() + payload.len();
    }
    [length.to_string().as_bytes(), &payload].concat()
}

fn member(name: &str, kind: u8, raw_size: u64, body: &[u8]) -> Vec<u8> {
    let mut header = tar::Header::new_ustar();
    header.set_path(name).unwrap();
    header.set_entry_type(tar::EntryType::new(kind));
    header.set_mode(0o644);
    header.set_size(raw_size);
    header.set_cksum();
    [header.as_bytes().as_slice(), body, &vec![0; (512 - body.len() % 512) % 512]].concat()
}

fn pax(body: &[u8]) -> Vec<u8> {
    member("PaxHeader", b'x', body.len() as u64, body)
}

fn reader(bytes: Vec<u8>, chunk: usize, limit: u64) -> TarMetadataMeter<Chunked> {
    TarMetadataMeter::new(Chunked { inner: Cursor::new(bytes), chunk }, test_limits(limit))
}

#[test]
fn pax_framing_matches_tar_across_chunk_boundaries_and_size_directions() {
    for (raw, size) in [(1, 700), (700, 1), (700, 0)] {
        let metadata = [
            record("mtime", b"1787334189.823045922"),
            record("LIBARCHIVE.xattr.com.apple.provenance", b"AQIAcwhBclAufnY"),
            record("SCHILY.xattr.com.apple.provenance", b"\x01\x02\0s\x08ArP.~v"),
            record("SCHILY.xattr.user.binary", b"\0\xff\xfe\xc3"),
            record("path", b"package/value"),
            record("size", size.to_string().as_bytes()),
        ].concat();
        let body = vec![b'a'; size];
        let bytes = [pax(&metadata), member("raw", b'0', raw, &body), member("sentinel", b'0', 3, b"end"), vec![0; 1024]].concat();
        for chunk in [1, 2, 3, 7, 511, 512, 513, 1023, 4096] {
            let mut output = Vec::new();
            reader(bytes.clone(), chunk, metadata.len() as u64).read_to_end(&mut output).unwrap();
            assert_eq!(output, bytes, "meter must retain original bytes");
            let mut archive = tar::Archive::new(reader(bytes.clone(), chunk, metadata.len() as u64));
            let mut entries = archive.entries().unwrap();
            let mut first = entries.next().unwrap().unwrap();
            assert_eq!(first.path_bytes().as_ref(), b"package/value");
            assert_eq!(first.size(), size as u64);
            let mut actual = Vec::new();
            first.read_to_end(&mut actual).unwrap();
            assert_eq!(actual, body);
            let mut sentinel = entries.next().unwrap().unwrap();
            assert_eq!(sentinel.path_bytes().as_ref(), b"sentinel");
            actual.clear();
            sentinel.read_to_end(&mut actual).unwrap();
            assert_eq!(actual, b"end");
            assert!(entries.next().is_none());
        }
    }
}

#[test]
fn pax_state_rejects_truncation_duplicates_mixed_and_dangling_metadata() {
    let metadata = record("path", b"safe");
    let extension = pax(&metadata);
    let file = member("raw", b'0', 0, b"");
    let gnu = member("LongName", b'L', 5, b"long\0");
    let invalid = [
        extension[..513].to_vec(), extension.clone(),
        [extension.clone(), vec![0; 1024]].concat(),
        [extension.clone(), extension.clone(), file.clone()].concat(),
        [extension.clone(), gnu.clone(), file.clone()].concat(),
        [gnu, extension, file.clone()].concat(),
        [pax(&[metadata.clone(), metadata].concat()), file.clone()].concat(),
        [pax(&record("SCHILY.xattr.user.binary", b"a\nb")), file.clone()].concat(),
        [pax(&record("size", b"01")), file.clone()].concat(),
        [pax(&record("GNU.sparse.major", b"1")), file.clone()].concat(),
        [pax(&record("path", "caf\u{e9}".as_bytes())), file.clone()].concat(),
        [pax(&record("size", b"9007199254740991")), file].concat(),
    ];
    for bytes in invalid {
        for chunk in [1, 7, 511, 512, 513, 4096] {
            let error = reader(bytes.clone(), chunk, 1024).read_to_end(&mut Vec::new()).unwrap_err();
            assert!(error.to_string().contains(INVALID_HEADER), "{error}");
        }
    }
}

#[test]
fn metadata_limit_precedes_body_allocation_and_sparse_rejection() {
    for kind in [b'x', b'g', b'X', b'N', b'L', b'K'] {
        let bytes = member("metadata", kind, 513, b"");
        let error = reader(bytes, 1, 512).read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains(META_LIMIT));
    }
    let metadata = record("path", b"safe");
    let mut sparse = member("sparse", b'S', 0, b"");
    sparse[482] = 1;
    let bytes = [pax(&metadata), sparse, vec![0; 512]].concat();
    let error = reader(bytes, 7, 511).read_to_end(&mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains(META_LIMIT));
}

#[test]
fn raw_framing_rejects_hidden_headers_non_file_bodies_and_missing_eof() {
    let file = member("value", b'0', 7, b"payload");
    let hidden = member("hidden", b'0', 0, b"");
    let mut invalid = vec![
        Vec::new(),
        file.clone(),
        [file.clone(), vec![0; 512]].concat(),
        [file.clone(), vec![0; 1023]].concat(),
        file[..511].to_vec(),
        file[..515].to_vec(),
        file[..1023].to_vec(),
        [file.clone(), vec![0; 512], hidden.clone(), vec![0; 1024]].concat(),
        [file.clone(), vec![0; 1024], hidden.clone(), vec![0; 1024]].concat(),
        [file.clone(), vec![0; 1537], vec![1]].concat(),
    ];
    for kind in [b'1', b'2', b'5'] {
        for base256 in [false, true] {
            let mut header = member("non-file", kind, 1, b"");
            if base256 {
                header[124..136].fill(0);
                header[124] = 0x80;
                header[135] = 1;
            }
            invalid.push([header, hidden.clone(), file.clone(), vec![0; 1024]].concat());
        }
    }
    for field in [b"0000000\0junk", b"\t0000000001\0", b"00000000008\0"] {
        let mut malformed = file.clone();
        malformed[124..136].copy_from_slice(field);
        invalid.push([malformed, vec![0; 1024]].concat());
    }
    for bytes in invalid {
        for chunk in [1, 7, 511, 512, 513, 1023, 4096] {
            let error = reader(bytes.clone(), chunk, 1024).read_to_end(&mut Vec::new()).unwrap_err();
            assert!(error.to_string().contains(INVALID_HEADER), "{error}");
        }
    }
}

#[test]
fn raw_framing_keeps_member_metadata_and_trailing_zero_bytes_unchanged() {
    let hidden = member("hidden", b'0', 0, b"");
    let body = [vec![0; 1024], hidden].concat();
    let mut accepted = vec![Vec::new()];
    for kind in [0, b'0', b'7', b'L', b'K', b'D'] {
        accepted.push(member("value", kind, body.len() as u64, &body));
    }
    for kind in [b'1', b'2', b'5'] {
        accepted.push(member("non-file", kind, 0, b""));
    }
    for field in [b"000000000007", b" 0000000007 ", b"7\0          ", b"\x80\0\0\0\0\0\0\0\0\0\0\x07"] {
        let mut file = member("value", b'0', 7, b"payload");
        file[124..136].copy_from_slice(field);
        accepted.push(file);
    }
    for bytes in accepted {
        for padding in [0, 1, 511, 512, 513] {
            let bytes = [bytes.clone(), vec![0; 1024 + padding]].concat();
            for chunk in [1, 7, 511, 512, 513, 1023, 4096] {
                let mut output = Vec::new();
                reader(bytes.clone(), chunk, 2048).read_to_end(&mut output).unwrap();
                assert_eq!(output, bytes);
            }
        }
    }
}

#[test]
fn member_budgets_stop_before_requesting_the_rejected_body() {
    struct GuardTail(Cursor<Vec<u8>>);
    impl Read for GuardTail {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            let remaining = self.0.get_ref().len() - self.0.position() as usize;
            assert!(output.len() <= remaining, "requested forbidden body tail");
            self.0.read(output)
        }
    }
    let base = TarMeterLimits { max_entries: 1, max_entry_bytes: 7, max_extracted_bytes: 7, ..test_limits(1024) };
    let file = member("first", b'0', 7, b"payload");
    let cases = [
        (member("large", b'0', 8, b""), base, "archive-entry-extracted-size-exceeds-limit"),
        (member("empty", b'0', 0, b""), TarMeterLimits { max_entries: 0, ..base }, "archive-entry-count-exceeds-limit"),
        ([file.clone(), member("second", b'0', 1, b"")].concat(), base, "archive-entry-count-exceeds-limit"),
        ([file.clone(), member("second", b'0', 1, b"")].concat(), TarMeterLimits { max_entries: 2, ..base }, "archive-extracted-size-exceeds-limit"),
        ([pax(&record("size", b"8")), member("raw", b'0', 0, b"")].concat(), base, "archive-entry-extracted-size-exceeds-limit"),
        ([pax(&record("size", b"0")), member("raw", b'0', 700, b""), member("second", b'0', 1, b"")].concat(), base, "archive-entry-count-exceeds-limit"),
        ([pax(&record("size", b"7")), member("raw", b'0', 0, b"payload"), pax(&record("size", b"1")), member("second", b'0', 0, b"")].concat(), TarMeterLimits { max_entries: 2, ..base }, "archive-extracted-size-exceeds-limit"),
    ];
    for (bytes, limits, code) in cases {
        let error = TarMetadataMeter::new(GuardTail(Cursor::new(bytes)), limits).read_to_end(&mut Vec::new()).unwrap_err();
        assert_eq!(error.to_string(), code);
    }
}

#[test]
fn member_budgets_exclude_metadata_and_padding_and_use_effective_sizes() {
    let bytes = [
        pax(&record("size", b"0")), member("raw", b'0', 700, b""),
        member("LongName", b'L', 5, b"name\0"), member("LongLink", b'K', 5, b"link\0"),
        member("value", b'0', 7, b"payload"), vec![0; 1024],
    ].concat();
    let limits = TarMeterLimits { max_entries: 2, max_entry_bytes: 7, max_extracted_bytes: 7, ..test_limits(1024) };
    let mut output = Vec::new();
    TarMetadataMeter::new(Cursor::new(bytes.clone()), limits).read_to_end(&mut output).unwrap();
    assert_eq!(output, bytes);
}

#[test]
fn decoded_ceiling_stops_unbounded_zero_and_metadata_tails() {
    struct Repeated {
        pattern: Vec<u8>,
        supplied: usize,
        ceiling: usize,
    }
    impl Read for Repeated {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            assert!(self.supplied + output.len() <= self.ceiling + 1, "read beyond overflow probe");
            for byte in output.iter_mut() {
                *byte = self.pattern[self.supplied % self.pattern.len()];
                self.supplied += 1;
            }
            Ok(output.len())
        }
    }
    for pattern in [
        vec![0; 512],
        member("LongName", b'L', 5, b"name\0"),
        [pax(&record("size", b"0")), member("empty", b'0', 0, b"")].concat(),
    ] {
        let ceiling = pattern.len() * 4;
        let mut source = Repeated { pattern, supplied: 0, ceiling };
        let mut output = Vec::new();
        let limits = TarMeterLimits { max_decoded_bytes: ceiling as u64, ..test_limits(1024) };
        let error = TarMetadataMeter::new(&mut source, limits).read_to_end(&mut output).unwrap_err();
        assert_eq!(error.to_string(), DECODED_LIMIT);
        assert_eq!(source.supplied, ceiling + 1);
        assert_eq!(output.len(), ceiling);
    }
}

#[test]
fn decoded_ceiling_charges_all_framing_and_retains_nonzero_trailer_errors() {
    let bytes = [pax(&record("path", b"value")), member("raw", b'0', 7, b"payload"), vec![0; 1537]].concat();
    for ceiling in [0, 1, 511, 512, 513, 1023, 1024, 1536, bytes.len() - 1, bytes.len()] {
        let limits = TarMeterLimits { max_decoded_bytes: ceiling as u64, ..test_limits(1024) };
        let mut output = Vec::new();
        let result = TarMetadataMeter::new(Cursor::new(bytes.clone()), limits).read_to_end(&mut output);
        if ceiling < bytes.len() {
            assert_eq!(result.unwrap_err().to_string(), DECODED_LIMIT);
        } else {
            result.unwrap();
            assert_eq!(output, bytes);
        }
    }
    let limits = TarMeterLimits { max_decoded_bytes: bytes.len() as u64, ..test_limits(1024) };
    let error = TarMetadataMeter::new(Cursor::new([bytes, vec![1]].concat()), limits).read_to_end(&mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains(INVALID_HEADER));
}

#[test]
fn unsafe_raw_sizes_and_padding_precede_member_budgets_even_with_pax() {
    for size in [MAX_SAFE_INTEGER + 1, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER - 510] {
        let mut header = member("value", b'0', 0, b"");
        header[124..136].fill(0);
        header[124] = 0x80;
        header[128..136].copy_from_slice(&size.to_be_bytes());
        for prefix in [Vec::new(), pax(&record("size", b"0"))] {
            let limits = TarMeterLimits { max_entry_bytes: 0, max_extracted_bytes: 0, ..test_limits(1024) };
            let error = TarMetadataMeter::new(Cursor::new([prefix, header.clone()].concat()), limits).read_to_end(&mut Vec::new()).unwrap_err();
            assert!(error.to_string().contains(INVALID_HEADER), "{error}");
        }
    }
}
