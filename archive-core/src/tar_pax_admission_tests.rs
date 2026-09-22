use super::{Chunked, checksum, member, pax, record, test_limits};
use crate::tar_meter::{MAX_SAFE_INTEGER, TarMember, TarMetadataMeter, TarMeterLimits};
use std::io::{self, Cursor, Read};

const PAX_INVALID: &str = "archive-header-invalid: unsupported or malformed PAX metadata";
const CHUNKS: [usize; 8] = [1, 7, 475, 500, 511, 512, 513, 4096];

fn observe(
    bytes: &[u8],
    chunk: usize,
    via_push: bool,
    limits: TarMeterLimits,
) -> (io::Result<()>, Vec<TarMember>) {
    let mut members = Vec::new();
    let mut forwarded = Vec::new();
    let result = (|| {
        if via_push {
            let mut meter = TarMetadataMeter::new((), limits);
            let mut offset = 0;
            while offset < bytes.len() {
                let offered = &bytes[offset..(offset + chunk).min(bytes.len())];
                let consumed = meter.push(offered);
                if let Some(member) = meter.take_member() {
                    members.push(member);
                }
                let consumed = consumed?;
                assert!(consumed > 0 && consumed <= offered.len());
                forwarded.extend_from_slice(&offered[..consumed]);
                offset += consumed;
            }
            meter.finish()?;
        } else {
            let source = Chunked {
                inner: Cursor::new(bytes.to_vec()),
                chunk,
            };
            let mut meter = TarMetadataMeter::new(source, limits);
            let mut scratch = [0; 4096];
            loop {
                let read = meter.read(&mut scratch);
                if let Some(member) = meter.take_member() {
                    members.push(member);
                }
                let read = read?;
                if read == 0 {
                    break;
                }
                forwarded.extend_from_slice(&scratch[..read]);
            }
        }
        assert_eq!(forwarded, bytes);
        Ok(())
    })();
    (result, members)
}

fn assert_rejected(metadata: &[u8], raw: &[u8], expected: &str) {
    let bytes = [pax(metadata), raw.to_vec()].concat();
    for windows_paths in [false, true] {
        for chunk in CHUNKS {
            for via_push in [false, true] {
                let limits = TarMeterLimits {
                    windows_paths,
                    max_entries: 0,
                    ..test_limits(1024)
                };
                let (result, members) = observe(&bytes, chunk, via_push, limits);
                let error = result.unwrap_err();
                assert_eq!(error.kind(), io::ErrorKind::InvalidData);
                assert_eq!(
                    error.to_string(),
                    expected,
                    "push={via_push}, chunk={chunk}, windows={windows_paths}"
                );
                assert!(members.is_empty(), "rejected header emitted a member");
            }
        }
    }
}

fn assert_admitted(metadata: &[u8], raw: &[u8], path: &str, kind: u8, payload: &[u8]) {
    let extension = pax(metadata);
    let first_offset = extension.len() + 512;
    let sentinel_offset = extension.len() + raw.len() + 512;
    let bytes = [
        extension,
        raw.to_vec(),
        member("sentinel", b'0', 3, b"end"),
        vec![0; 1024],
    ]
    .concat();
    for windows_paths in [false, true] {
        for chunk in CHUNKS {
            for via_push in [false, true] {
                let limits = TarMeterLimits {
                    windows_paths,
                    ..test_limits(1024)
                };
                let (result, members) = observe(&bytes, chunk, via_push, limits);
                result.unwrap();
                assert_eq!(members.len(), 2);
                assert_eq!(members[0].path, path);
                assert_eq!(members[0].entry_type, kind);
                assert_eq!(members[0].size, payload.len() as u64);
                assert_eq!(members[0].mode, 0o644);
                assert_eq!(members[0].offset, first_offset as u64);
                assert_eq!(&bytes[first_offset..first_offset + payload.len()], payload);
                assert_eq!(members[1].path, "sentinel");
                assert_eq!(members[1].entry_type, b'0');
                assert_eq!(members[1].size, 3);
                assert_eq!(members[1].offset, sentinel_offset as u64);
                assert_eq!(&bytes[sentinel_offset..sentinel_offset + 3], b"end");
            }
        }
    }
}

fn raw_size(raw: &mut [u8], size: u64) {
    raw[124..136].fill(0);
    raw[124] = 0x80;
    raw[128..136].copy_from_slice(&size.to_be_bytes());
    checksum(raw);
}

#[test]
fn pax_cannot_mask_invalid_raw_fields_or_link_presence() {
    let metadata = [record("path", b"safe"), record("linkpath", b"target")].concat();
    for kind in [b'0', b'2', b'V'] {
        for offset in [0, 157, 345] {
            for value in [b"\xc3\x28".as_slice(), b"\xe2\x82", b"safe\0hidden"] {
                let mut raw = member("raw", kind, 0, b"");
                raw[offset..offset + 100].fill(0);
                raw[offset..offset + value.len()].copy_from_slice(value);
                checksum(&mut raw);
                assert_rejected(&metadata, &raw, "archive-entry-path-invalid");
            }
        }
    }
    for kind in [b'0', b'V', b'1', b'2'] {
        let mut raw = member("raw", kind, 0, b"");
        raw[157..257].fill(0);
        let is_link = matches!(kind, b'1' | b'2');
        if !is_link {
            raw[157..163].copy_from_slice(b"target");
        }
        checksum(&mut raw);
        let expected = if is_link {
            "archive-header-invalid: linkname required on a link header"
        } else {
            "archive-header-invalid: linkname forbidden on a non-link header"
        };
        assert_rejected(&metadata, &raw, expected);
    }
    let mut empty = member("raw", b'V', 0, b"");
    empty[..100].fill(0);
    checksum(&mut empty);
    assert_rejected(
        &metadata,
        &empty,
        "archive-header-invalid: entry path is empty",
    );
}

#[test]
fn raw_size_admission_precedes_pax_override_type_and_count_policy() {
    let metadata = record("size", b"0");
    for kind in [b'0', b'5', b'V'] {
        for (size, expected) in [
            (
                MAX_SAFE_INTEGER + 1,
                "archive-header-invalid: base-256 size exceeds the safe integer range",
            ),
            (
                MAX_SAFE_INTEGER,
                "archive-header-invalid: entry padding exceeds the safe integer range",
            ),
            (
                MAX_SAFE_INTEGER - 510,
                "archive-header-invalid: entry padding exceeds the safe integer range",
            ),
        ] {
            let mut raw = member("raw", kind, 0, b"");
            raw_size(&mut raw, size);
            assert_rejected(&metadata, &raw, expected);
        }
    }
    let mut raw = member("raw", b'V', 0, b"");
    raw[124..136].copy_from_slice(b"0000000\0junk");
    checksum(&mut raw);
    assert_rejected(
        &metadata,
        &raw,
        "archive-header-invalid: size has non-padding bytes after NUL",
    );
    assert_rejected(&record("size", b"9007199254740992"), &raw, PAX_INVALID);
}

#[test]
fn pax_retains_effective_size_type_and_linkpath_constraints() {
    for kind in [b'1', b'2', b'5'] {
        assert_rejected(
            &record("size", b"0"),
            &member("raw", kind, 1, b""),
            "archive-header-invalid: directory or link has a nonzero body size",
        );
        assert_rejected(
            &record("size", b"1"),
            &member("raw", kind, 0, b""),
            PAX_INVALID,
        );
    }
    for kind in [b'3', b'4', b'6', b'D', b'V'] {
        assert_rejected(
            &record("size", b"0"),
            &member("raw", kind, 0, b""),
            PAX_INVALID,
        );
    }
    let metadata = [record("path", b"renamed"), record("linkpath", b"target")].concat();
    for kind in [0, b'0', b'5', b'7'] {
        assert_rejected(&metadata, &member("raw", kind, 0, b""), PAX_INVALID);
    }
    for kind in [b'1', b'2'] {
        assert_admitted(
            &metadata,
            &member("raw", kind, 0, b""),
            "renamed",
            kind,
            b"",
        );
    }
}

#[test]
fn admitted_pax_sizes_preserve_ranges_and_reset_at_the_next_member() {
    for kind in [0, b'0', b'7'] {
        for (declared, effective) in [(MAX_SAFE_INTEGER - 511, 0), (0, 513), (700, 1)] {
            let payload = vec![0xa7; effective];
            let mut raw = member("raw", kind, 0, &payload);
            raw[156] = kind;
            raw_size(&mut raw, declared);
            let metadata = [
                record("path", "caf\u{e9}/value".as_bytes()),
                record("size", effective.to_string().as_bytes()),
            ]
            .concat();
            assert_admitted(&metadata, &raw, "caf\u{e9}/value", kind, &payload);
        }
    }
}

#[test]
fn pax_uses_the_admitted_star_or_full_ustar_prefix_boundary() {
    let metadata = record("size", b"0");
    let mut star = member("leaf", b'0', 0, b"");
    star[345..475].fill(b'p');
    star[476..500].fill(0xff);
    checksum(&mut star);
    assert_admitted(
        &metadata,
        &star,
        &format!("{}/leaf", "p".repeat(130)),
        b'0',
        b"",
    );

    for offset in [474, 475] {
        let mut invalid = star.clone();
        invalid[offset] = 0xff;
        checksum(&mut invalid);
        assert_rejected(&metadata, &invalid, "archive-entry-path-invalid");
    }
    let mut full = member("leaf", b'0', 0, b"");
    full[345..500].fill(b'p');
    checksum(&mut full);
    assert_admitted(
        &metadata,
        &full,
        &format!("{}/leaf", "p".repeat(155)),
        b'0',
        b"",
    );
    full[499] = 0xff;
    checksum(&mut full);
    assert_rejected(&metadata, &full, "archive-entry-path-invalid");

    for offset in [474, 475] {
        let mut hidden = member("leaf", b'0', 0, b"");
        hidden[345..348].copy_from_slice(b"pkg");
        hidden[offset] = b'x';
        checksum(&mut hidden);
        assert_rejected(&metadata, &hidden, "archive-entry-path-invalid");
    }
}

#[test]
fn pax_preserves_raw_and_effective_trailing_separator_rules() {
    for separator in [b'/', b'\\'] {
        let mut raw = member("raw", b'0', 0, b"");
        raw[3] = separator;
        checksum(&mut raw);
        let expected = if separator == b'/' {
            "archive-header-invalid: non-directory entry path ends with a separator"
        } else {
            PAX_INVALID
        };
        assert_rejected(&record("path", b"safe"), &raw, expected);
        let name = [b"directory".as_slice(), &[separator]].concat();
        assert_rejected(
            &record("path", &name),
            &member("raw", b'0', 0, b""),
            PAX_INVALID,
        );

        raw[156] = b'5';
        checksum(&mut raw);
        assert_admitted(&record("path", b"safe"), &raw, "safe", b'5', b"");
        let path = std::str::from_utf8(&name).unwrap();
        assert_admitted(
            &record("path", &name),
            &member("raw", b'5', 0, b""),
            path,
            b'5',
            b"",
        );
    }
}
