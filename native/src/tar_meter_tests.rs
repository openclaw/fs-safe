use super::*;
use std::io::Cursor;

pub(super) fn test_limits(max_meta_entry_bytes: u64) -> TarMeterLimits {
    TarMeterLimits {
        max_meta_entry_bytes,
        max_entries: 50_000,
        max_decoded_bytes: 768 * 1024 * 1024,
        max_manifest_bytes: MAX_MANIFEST_BYTES,
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
    if matches!(kind, b'1' | b'2') {
        header.set_link_name("target").unwrap();
    }
    header.set_mode(0o644);
    header.set_size(raw_size);
    header.set_cksum();
    [header.as_bytes().as_slice(), body, &vec![0; (512 - body.len() % 512) % 512]].concat()
}

pub(super) fn checksum(bytes: &mut [u8]) {
    bytes[148..156].fill(b' ');
    let sum: u64 = bytes[..512].iter().map(|byte| *byte as u64).sum();
    bytes[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
}

fn pax(body: &[u8]) -> Vec<u8> {
    member("PaxHeader", b'x', body.len() as u64, body)
}

fn reader(bytes: Vec<u8>, chunk: usize, limit: u64) -> TarMetadataMeter<Chunked> {
    TarMetadataMeter::new(Chunked { inner: Cursor::new(bytes), chunk }, test_limits(limit))
}

// Mirrored from the exhaustive node-tar parser probe in the JS meter tests.
fn node_tar_hidden_flags() -> Vec<u8> {
    let flags: Vec<_> = (0..=255_u8).filter(|kind| !matches!(kind,
        0 | b'0'..=b'7' | b'D' | b'g' | b'x' | b'K' | b'L' | b'N' | b'X'
    )).collect();
    assert_eq!(flags.len(), 240);
    flags
}

#[test]
fn ignored_members_validate_raw_names_even_when_gnu_overrides_them() {
    for kind in node_tar_hidden_flags().into_iter().filter(|kind| *kind != b'S') {
        for name in ["../bad", "pkg/../bad", "pkg\\..\\bad", "/bad", "\\bad", "C:bad", "pkg/C:bad", "safe\0hidden"] {
            let mut raw = member("placeholder", kind, 0, b"");
            raw[..100].fill(0);
            raw[..name.len()].copy_from_slice(name.as_bytes());
            checksum(&mut raw);
            for overridden in [false, true] {
                let mut bytes = if overridden { member("LongName", b'L', 5, b"safe\0") } else { Vec::new() };
                bytes.extend_from_slice(&raw);
                bytes.extend_from_slice(&[0; 1024]);
                for chunk in [1, 511, 4096] {
                    let error = reader(bytes.clone(), chunk, 1024).read_to_end(&mut Vec::new()).unwrap_err();
                    assert_eq!(error.to_string(), crate::tar_path::INVALID_PATH, "kind={kind}, name={name:?}");
                }
            }
        }
        let bytes = [member("./pkg//opaque", kind, 7, b"ignored"), member("pkg/file", b'0', 4, b"file"), vec![0; 1024]].concat();
        for chunk in [1, 511, 4096] {
            let mut output = Vec::new();
            reader(bytes.clone(), chunk, 1024).read_to_end(&mut output).unwrap();
            assert_eq!(output, bytes);
        }
        let mut limits = test_limits(1024);
        limits.max_entries = 1;
        let error = TarMetadataMeter::new(Cursor::new(bytes), limits).read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("archive-entry-count-exceeds-limit"));
    }
}

#[test]
fn pax_and_fixed_prefix_paths_are_admitted_before_parser_replacement() {
    let mut raw = member("safe", b'V', 0, b"");
    for prefix in ["../bad", "/bad", "C:bad", "safe\0hidden"] {
        raw[345..500].fill(0);
        raw[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        checksum(&mut raw);
        let error = reader([raw.clone(), vec![0; 1024]].concat(), 7, 1024).read_to_end(&mut Vec::new()).unwrap_err();
        assert_eq!(error.to_string(), crate::tar_path::INVALID_PATH);
    }
    let bytes = [pax(&record("path", b"pkg/../bad")), member("safe", b'0', 0, b""), vec![0; 1024]].concat();
    let error = reader(bytes, 7, 1024).read_to_end(&mut Vec::new()).unwrap_err();
    assert_eq!(error.to_string(), crate::tar_path::INVALID_PATH);
}

#[test]
fn star_timestamps_are_not_treated_as_a_hidden_prefix_suffix() {
    let mut raw = member("safe", b'V', 0, b"");
    raw[345..348].copy_from_slice(b"pkg");
    raw[476..488].copy_from_slice(b"00000000001\0");
    raw[488..500].copy_from_slice(b"00000000002\0");
    checksum(&mut raw);
    let bytes = [raw, vec![0; 1024]].concat();
    let mut output = Vec::new();
    reader(bytes.clone(), 7, 1024).read_to_end(&mut output).unwrap();
    assert_eq!(bytes, output);
}

#[test]
fn gnu_bodies_and_chains_reject_before_parser_normalization() {
    let file = member("raw", b'0', 0, b"");
    let mut invalid = Vec::new();
    for kind in [b'L', b'K'] {
        for body in [b"".as_slice(), b"\0", b"safe\0../hidden\0", b"safe\0\0", b"safe\0suffix", b"\xc3\x28", b"\xe2\x82"] {
            invalid.push([member("metadata", kind, body.len() as u64, body), file.clone(), vec![0; 1024]].concat());
        }
        let extension = member("metadata", kind, 5, b"name\0");
        let other = member("metadata", if kind == b'L' { b'K' } else { b'L' }, 4, b"name");
        for prefix in [
            extension.clone(), extension[..514].to_vec(),
            [extension.clone(), vec![0; 1024]].concat(),
            [extension.clone(), extension.clone(), file.clone()].concat(),
            [extension.clone(), other, extension.clone(), file.clone()].concat(),
            [extension.clone(), pax(&record("path", b"safe")), file.clone()].concat(),
            [pax(&record("path", b"safe")), extension, file.clone()].concat(),
        ] {
            invalid.push(prefix);
        }
    }
    for bytes in invalid {
        for chunk in [1, 7, 511, 513, 4096] {
            let error = reader(bytes.clone(), chunk, 1024).read_to_end(&mut Vec::new()).unwrap_err();
            assert!(error.to_string().contains(INVALID_HEADER), "{error}");
        }
    }
}

#[test]
fn gnu_effective_names_reject_raw_traversal_and_drives_but_link_targets_remain_policy_owned() {
    for name in ["pkg/../hidden", "pkg\\..\\hidden", "/hidden", "\\hidden", "C:hidden", "pkg/C:hidden"] {
        for kind in [b'L', b'K'] {
            let bytes = [member("metadata", kind, name.len() as u64, name.as_bytes()), member("raw", b'2', 0, b""), vec![0; 1024]].concat();
            for chunk in [1, 511, 4096] {
                let mut output = Vec::new();
                let result = reader(bytes.clone(), chunk, 1024).read_to_end(&mut output);
                if kind == b'L' {
                    assert_eq!(result.unwrap_err().to_string(), INVALID_GNU_PATH);
                } else {
                    result.unwrap();
                    assert_eq!(output, bytes);
                }
            }
        }
    }
}

#[test]
fn gnu_valid_utf8_terminators_pairs_and_state_reset_preserve_every_byte() {
    for nul in [false, true] {
        let name = format!("./pkg//caf\u{e9}{}", if nul { "\0" } else { "" });
        let long_name = member("metadata", b'L', name.len() as u64, name.as_bytes());
        let long_link = member("metadata", b'K', name.len() as u64, name.as_bytes());
        let file = member("raw", b'0', 5, b"value");
        for extensions in [
            long_name.clone(), long_link.clone(),
            [long_name.clone(), long_link.clone()].concat(),
            [long_link, long_name].concat(),
        ] {
            let bytes = [extensions.clone(), file.clone(), extensions, file.clone(), vec![0; 1024]].concat();
            for chunk in [1, 7, 511, 512, 513, 4096] {
                let mut output = Vec::new();
                reader(bytes.clone(), chunk, name.len() as u64).read_to_end(&mut output).unwrap();
                assert_eq!(output, bytes);
                let error = reader(bytes.clone(), chunk, name.len() as u64 - 1).read_to_end(&mut Vec::new()).unwrap_err();
                assert_eq!(error.to_string(), META_LIMIT);
            }
        }
    }
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
    checksum(&mut sparse);
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
            checksum(&mut header);
            invalid.push([header, hidden.clone(), file.clone(), vec![0; 1024]].concat());
        }
    }
    for field in [b"0000000\0junk", b"\t0000000001\0", b"00000000008\0"] {
        let mut malformed = file.clone();
        malformed[124..136].copy_from_slice(field);
        checksum(&mut malformed);
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
    for kind in [0, b'0', b'7', b'D'] {
        accepted.push(member("value", kind, body.len() as u64, &body));
    }
    for kind in [b'L', b'K'] {
        accepted.push([member("metadata", kind, 5, b"name\0"), member("value", b'0', 0, b"")].concat());
    }
    for kind in [b'1', b'2', b'5'] {
        accepted.push(member("non-file", kind, 0, b""));
    }
    for field in [b"000000000007", b" 0000000007 ", b"7\0          ", b"\x80\0\0\0\0\0\0\0\0\0\0\x07"] {
        let mut file = member("value", b'0', 7, b"payload");
        file[124..136].copy_from_slice(field);
        checksum(&mut file);
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
fn logical_count_stops_before_requesting_the_rejected_body() {
    struct GuardTail(Cursor<Vec<u8>>);
    impl Read for GuardTail {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            let remaining = self.0.get_ref().len() - self.0.position() as usize;
            assert!(output.len() <= remaining, "requested forbidden body tail");
            self.0.read(output)
        }
    }
    let base = TarMeterLimits { max_entries: 1, ..test_limits(1024) };
    let file = member("first", b'0', 7, b"payload");
    let cases = [
        (member("empty", b'0', 0, b""), TarMeterLimits { max_entries: 0, ..base }, "archive-entry-count-exceeds-limit"),
        ([file.clone(), member("second", b'0', 1, b"")].concat(), base, "archive-entry-count-exceeds-limit"),
        ([pax(&record("size", b"0")), member("raw", b'0', 700, b""), member("second", b'0', 1, b"")].concat(), base, "archive-entry-count-exceeds-limit"),
    ];
    for (bytes, limits, code) in cases {
        let error = TarMetadataMeter::new(GuardTail(Cursor::new(bytes)), limits).read_to_end(&mut Vec::new()).unwrap_err();
        assert_eq!(error.to_string(), code);
    }
}

#[test]
fn logical_count_excludes_metadata_and_padding_and_uses_effective_framing() {
    let bytes = [
        pax(&record("size", b"0")), member("raw", b'0', 700, b""),
        member("LongName", b'L', 5, b"name\0"), member("LongLink", b'K', 5, b"link\0"),
        member("value", b'0', 7, b"payload"), vec![0; 1024],
    ].concat();
    let limits = TarMeterLimits { max_entries: 2, ..test_limits(1024) };
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
        [member("LongName", b'L', 5, b"name\0"), member("empty", b'0', 0, b"")].concat(),
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
fn unsafe_raw_sizes_and_padding_precede_counts_even_with_pax() {
    for size in [MAX_SAFE_INTEGER + 1, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER - 510] {
        let mut header = member("value", b'0', 0, b"");
        header[124..136].fill(0);
        header[124] = 0x80;
        header[128..136].copy_from_slice(&size.to_be_bytes());
        checksum(&mut header);
        for prefix in [Vec::new(), pax(&record("size", b"0"))] {
            let limits = TarMeterLimits { max_entries: 0, ..test_limits(1024) };
            let error = TarMetadataMeter::new(Cursor::new([prefix, header.clone()].concat()), limits).read_to_end(&mut Vec::new()).unwrap_err();
            assert!(error.to_string().contains(INVALID_HEADER), "{error}");
        }
    }
}

#[test]
fn checksum_precedes_metadata_limits_and_member_emission() {
    for kind in 0..=255_u8 {
        let mut bytes = member("raw", kind, 513, b"");
        bytes[0] ^= 1;
        let limits = TarMeterLimits { max_entries: 0, ..test_limits(0) };
        let error = TarMetadataMeter::new(Cursor::new(bytes), limits).read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("checksum failure"));
    }
}

#[test]
fn fixed_fields_are_strict_utf8_and_non_links_cannot_have_linknames() {
    for kind in std::iter::once(b'0').chain(node_tar_hidden_flags()) {
        for offset in [0, 157, 345] {
            for value in [b"\xc3\x28".as_slice(), b"\xe2\x82", b"safe\0hidden"] {
                let mut raw = member("raw", kind, 0, b"");
                raw[offset..offset + 100].fill(0);
                raw[offset..offset + value.len()].copy_from_slice(value);
                checksum(&mut raw);
                let bytes = [member("LongName", b'L', 5, b"safe\0"), raw, vec![0; 1024]].concat();
                let error = reader(bytes, 7, 1024).read_to_end(&mut Vec::new()).unwrap_err();
                assert_eq!(error.to_string(), crate::tar_path::INVALID_PATH);
            }
        }
        let mut raw = member("raw", kind, 0, b"");
        raw[157..163].copy_from_slice(b"target");
        checksum(&mut raw);
        let error = reader(raw, 7, 1024).read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("linkname forbidden"));
    }
}

#[test]
fn raw_linkname_type_consistency_precedes_metadata_and_member_admission() {
    for kind in 0..=255_u8 {
        let is_link = matches!(kind, b'1' | b'2');
        let mut raw = member("raw", kind, 0, b"");
        raw[157..257].fill(0);
        if !is_link { raw[157..163].copy_from_slice(b"target"); }
        checksum(&mut raw);
        let limits = TarMeterLimits { max_entries: 0, ..test_limits(0) };
        let mut meter = TarMetadataMeter::new(Cursor::new(raw), limits);
        let error = meter.read_to_end(&mut Vec::new()).unwrap_err();
        let expected = if is_link { "linkname required on a link header" } else { "linkname forbidden on a non-link header" };
        assert_eq!(error.to_string(), format!("{INVALID_HEADER}: {expected}"));
        assert_eq!(meter.entries, 0);
        assert_eq!(meter.manifest_bytes, 0);
    }
}

#[test]
fn every_hidden_flag_obeys_manifest_and_count_limits_or_rejects_sparse() {
    for kind in node_tar_hidden_flags() {
        let raw = member("pkg/caf\u{e9}", kind, 0, b"");
        let cost = 64 + 2 * "pkg/caf\u{e9}".len() as u64;
        for (max_entries, max_manifest_bytes, admitted, code) in [
            (0, cost, 0, "archive-entry-count-exceeds-limit"),
            (1, cost - 1, 0, MANIFEST_LIMIT),
            (1, cost * 2, 1, "archive-entry-count-exceeds-limit"),
            (2, cost, 1, MANIFEST_LIMIT),
        ] {
            let limits = TarMeterLimits { max_entries, max_manifest_bytes, ..test_limits(1024) };
            let bytes = [raw.clone(), raw.clone()].concat();
            let mut meter = TarMetadataMeter::new(Cursor::new(bytes), limits);
            let error = meter.read_to_end(&mut Vec::new()).unwrap_err();
            if kind == b'S' {
                assert_eq!(error.to_string(), format!("{INVALID_HEADER}: GNU sparse entries are not supported"));
                assert_eq!(meter.entries, 0);
                assert_eq!(meter.manifest_bytes, 0);
            } else {
                assert_eq!(error.to_string(), code, "kind={kind}");
                assert_eq!(meter.manifest_bytes, admitted * cost);
            }
        }
    }
}

#[test]
fn gnu_trailing_separator_requires_a_raw_directory_type() {
    for kind in [b'0', b'V', b'?', b'5', b'D'] {
        for name in ["pkg/directory/", "pkg/directory\\"] {
            let bytes = [member("LongName", b'L', name.len() as u64, name.as_bytes()), member("raw", kind, 0, b""), vec![0; 1024]].concat();
            let mut output = Vec::new();
            let result = reader(bytes.clone(), 7, 1024).read_to_end(&mut output);
            if matches!(kind, b'5' | b'D') {
                result.unwrap();
                assert_eq!(bytes, output);
            } else {
                assert!(result.unwrap_err().to_string().contains("non-directory path ends with a separator"));
            }
        }
    }
}

#[test]
fn raw_component_normalization_is_checked_before_gnu_replacement() {
    for count in [28, 30] {
        let raw = member(&"각".repeat(count), b'V', 0, b"");
        let bytes = [member("LongName", b'L', 5, b"safe\0"), raw, vec![0; 1024]].concat();
        let result = reader(bytes, 7, 1024).read_to_end(&mut Vec::new());
        if count == 28 { result.unwrap(); }
        else { assert_eq!(result.unwrap_err().to_string(), crate::tar_path::INVALID_PATH); }
    }
}

#[test]
fn manifest_budget_stops_repeated_long_paths_before_another_read() {
    struct Repeated { pattern: Vec<u8>, supplied: usize, maximum: usize }
    impl Read for Repeated {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            assert!(self.supplied + output.len() <= self.maximum, "read after manifest overflow");
            for byte in output.iter_mut() {
                *byte = self.pattern[self.supplied % self.pattern.len()];
                self.supplied += 1;
            }
            Ok(output.len())
        }
    }
    let name = vec!["a".repeat(255); 4095].join("/");
    let cost = 64 + 2 * name.len() as u64;
    for extension in [member("LongName", b'L', name.len() as u64, name.as_bytes()), pax(&record("path", name.as_bytes()))] {
        let pattern = [extension, member("raw", b'0', 0, b"")].concat();
        let allowed = MAX_MANIFEST_BYTES / cost;
        assert_eq!(allowed, 32);
        let maximum = pattern.len() * (allowed as usize + 1);
        let mut source = Repeated { pattern, supplied: 0, maximum };
        let mut meter = TarMetadataMeter::new(&mut source, test_limits(1024 * 1024));
        let error = io::copy(&mut meter, &mut io::sink()).unwrap_err();
        assert_eq!(error.to_string(), MANIFEST_LIMIT);
        assert_eq!(meter.manifest_bytes, allowed * cost);
        assert_eq!(source.supplied, maximum);
    }
}
