//! Parser compatibility only: these tests never extract an archive.
use fs_safe_archive_core::{TarMember, TarMetadataMeter, TarMeterLimits};
use std::io::{self, Cursor, Read};
use std::path::Path;

const INDEX: &str = include_str!("fixtures/interop/cases.tsv");
const CHUNKS: [usize; 7] = [1, 7, 511, 512, 513, 4096, 65536];

struct Case<'a> {
    id: &'a str,
    bytes: Vec<u8>,
    expected: [&'a str; 2],
    reference: &'a str,
    limits: TarMeterLimits,
}

fn cases() -> Vec<Case<'static>> {
    INDEX
        .lines()
        .skip(1)
        .map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            assert_eq!(fields.len(), 10);
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/interop")
                .join(format!("{}.tar.hex", fields[0]));
            let text = std::fs::read_to_string(path).unwrap();
            let lines: Vec<_> = text.strip_suffix('\n').unwrap().split('\n').collect();
            let mut bytes = Vec::new();
            for (index, line) in lines.iter().enumerate() {
                assert!(!line.is_empty() && line.len() <= 128 && line.len() % 2 == 0);
                if index + 1 < lines.len() {
                    assert_eq!(line.len(), 128);
                }
                assert!(
                    line.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                );
                for pair in line.as_bytes().chunks_exact(2) {
                    bytes.push(u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap());
                }
            }
            assert_eq!(bytes.len(), fields[2].parse::<usize>().unwrap());
            Case {
                id: fields[0],
                bytes,
                expected: [fields[3], fields[4]],
                reference: fields[5],
                limits: TarMeterLimits {
                    windows_paths: false,
                    max_entries: fields[6].parse().unwrap(),
                    max_meta_entry_bytes: fields[7].parse().unwrap(),
                    max_decoded_bytes: fields[8].parse().unwrap(),
                    max_manifest_bytes: fields[9].parse().unwrap(),
                },
            }
        })
        .collect()
}

struct Chunked<'a> {
    bytes: Cursor<&'a [u8]>,
    chunk: usize,
}

impl Read for Chunked<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let length = output.len().min(self.chunk);
        self.bytes.read(&mut output[..length])
    }
}

struct Observation {
    result: io::Result<()>,
    members: Vec<TarMember>,
    forwarded: Vec<u8>,
}

fn observe(case: &Case<'_>, windows: bool, chunk: usize, push: bool) -> Observation {
    let limits = TarMeterLimits {
        windows_paths: windows,
        ..case.limits
    };
    let mut members = Vec::new();
    let mut forwarded = Vec::new();
    let result = (|| {
        if push {
            let mut meter = TarMetadataMeter::new((), limits);
            let mut offset = 0;
            while offset < case.bytes.len() {
                // The core accepts empty pushes; the private WASM ABI rejects them.
                assert_eq!(meter.push(&[])?, 0);
                let end = (offset + chunk).min(case.bytes.len());
                let consumed = meter.push(&case.bytes[offset..end]);
                if let Some(member) = meter.take_member() {
                    members.push(member);
                }
                let consumed = consumed?;
                assert!(consumed > 0 && consumed <= end - offset);
                forwarded.extend_from_slice(&case.bytes[offset..offset + consumed]);
                offset += consumed;
            }
            meter.finish()?;
        } else {
            let source = Chunked {
                bytes: Cursor::new(case.bytes.as_slice()),
                chunk,
            };
            let mut meter = TarMetadataMeter::new(source, limits);
            let mut output = [0; 4096];
            loop {
                assert_eq!(meter.read(&mut [])?, 0);
                let consumed = meter.read(&mut output);
                if let Some(member) = meter.take_member() {
                    members.push(member);
                }
                let consumed = consumed?;
                if consumed == 0 {
                    break;
                }
                forwarded.extend_from_slice(&output[..consumed]);
            }
        }
        Ok(())
    })();
    Observation {
        result,
        members,
        forwarded,
    }
}

struct Reference {
    path: Vec<u8>,
    kind: u8,
    size: u64,
    mode: u32,
    offset: u64,
    payload: Vec<u8>,
}

fn reference(bytes: &[u8]) -> io::Result<Vec<Reference>> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let mut members = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let mut member = Reference {
            path: entry.path_bytes().into_owned(),
            kind: entry.header().entry_type().as_byte(),
            size: entry.size(),
            mode: entry.header().mode()? & 0o7777,
            offset: entry.raw_file_position(),
            payload: Vec::new(),
        };
        entry.read_to_end(&mut member.payload)?;
        members.push(member);
    }
    Ok(members)
}

#[test]
fn corpus_preserves_strict_contract_and_reference_member_ranges() {
    for case in cases() {
        let reference = reference(&case.bytes);
        assert_eq!(
            reference.is_ok(),
            case.reference == "accept",
            "{}: tar reader",
            case.id
        );
        for windows in [false, true] {
            for chunk in CHUNKS {
                for push in [false, true] {
                    let observed = observe(&case, windows, chunk, push);
                    let context =
                        format!("{}: windows={windows}, chunk={chunk}, push={push}", case.id);
                    let expected = case.expected[usize::from(windows)];
                    if expected != "ok" {
                        let error = observed.result.unwrap_err();
                        assert_eq!(error.to_string(), expected, "{context}");
                        let kind = match expected {
                            "archive-entry-count-exceeds-limit"
                            | "archive-decoded-size-exceeds-limit"
                            | "archive-manifest-size-exceeds-limit" => io::ErrorKind::Other,
                            _ => io::ErrorKind::InvalidData,
                        };
                        assert_eq!(error.kind(), kind, "{context}");
                        continue;
                    }
                    observed.result.unwrap();
                    assert_eq!(observed.forwarded, case.bytes, "{context}");
                    let reference = reference.as_ref().unwrap();
                    assert_eq!(observed.members.len(), reference.len(), "{context}");
                    for (member, expected) in observed.members.iter().zip(reference) {
                        assert_eq!(member.path.as_bytes(), expected.path, "{context}");
                        assert_eq!(member.entry_type, expected.kind, "{context}");
                        assert_eq!(member.size, expected.size, "{context}");
                        assert_eq!(member.mode, expected.mode, "{context}");
                        assert_eq!(member.offset, expected.offset, "{context}");
                        let start = member.offset as usize;
                        let end = start + member.size as usize;
                        assert_eq!(case.bytes[start..end], expected.payload, "{context}");
                    }
                }
            }
        }
    }
}

#[test]
fn directory_link_writer_pattern_retains_metadata_but_is_not_admitted() {
    // Public OCM archive.rs uses these tar 0.4.46 calls for directory links.
    // Its filesystem capture and restore functions are not executed here.
    let mut builder = tar::Builder::new(Vec::new());
    builder
        .append_pax_extensions([("LIBARCHIVE.symlinktype", &b"dir"[..])])
        .unwrap();
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_mode(0o644);
    header.set_size(0);
    builder.append_link(&mut header, "link", "target").unwrap();
    let bytes = builder.into_inner().unwrap();
    let mut archive = tar::Archive::new(Cursor::new(&bytes));
    let mut entries = archive.entries().unwrap();
    let mut entry = entries.next().unwrap().unwrap();
    assert_eq!(entry.path_bytes().as_ref(), b"link");
    assert_eq!(entry.link_name_bytes().unwrap().as_ref(), b"target");
    let attributes = entry.pax_extensions().unwrap().unwrap();
    assert!(attributes.map(Result::unwrap).any(|attribute| {
        attribute.key_bytes() == b"LIBARCHIVE.symlinktype" && attribute.value_bytes() == b"dir"
    }));
    assert!(entries.next().is_none());
    let mut case = cases()
        .into_iter()
        .find(|case| case.id == "rust-tar-directory-link")
        .unwrap();
    assert_eq!(bytes, case.bytes, "golden writer output changed");
    assert!(bytes[..100].iter().all(|byte| *byte == 0));
    for named_header in [false, true] {
        case.bytes = bytes.clone();
        let expected = if named_header {
            // Isolate the unsupported key without weakening raw header policy.
            case.bytes[..9].copy_from_slice(b"PaxHeader");
            case.bytes[148..156].fill(b' ');
            let sum: u64 = case.bytes[..512].iter().map(|byte| *byte as u64).sum();
            case.bytes[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            "archive-header-invalid: unsupported or malformed PAX metadata"
        } else {
            "archive-header-invalid: entry path is empty"
        };
        for windows in [false, true] {
            for chunk in CHUNKS {
                for push in [false, true] {
                    let observed = observe(&case, windows, chunk, push);
                    assert_eq!(
                        observed.result.unwrap_err().to_string(),
                        expected,
                        "named_header={named_header}"
                    );
                    assert!(observed.members.is_empty());
                }
            }
        }
    }
}
