use super::{TarMember, TarMetadataMeter, TarMeterLimits};
use std::cell::Cell;
use std::io::{self, ErrorKind, Read};
use std::rc::Rc;

const CHUNKS: [usize; 6] = [1, 7, 511, 512, 513, 65536];

fn limits() -> TarMeterLimits {
    TarMeterLimits {
        windows_paths: cfg!(windows),
        max_entries: 8,
        max_meta_entry_bytes: 4096,
        max_decoded_bytes: 1024 * 1024,
        max_manifest_bytes: 4096,
    }
}

fn header(name: &str, kind: u8, size: u64) -> tar::Header {
    let mut header = tar::Header::new_ustar();
    header.set_path(name).unwrap();
    header.set_entry_type(tar::EntryType::new(kind));
    if matches!(kind, b'1' | b'2') {
        header.set_link_name("target").unwrap();
    }
    header.set_mode(0o640);
    header.set_size(size);
    header.set_cksum();
    header
}

fn entry(name: &str, kind: u8, declared_size: u64, body: &[u8]) -> Vec<u8> {
    let mut bytes = header(name, kind, declared_size).as_bytes().to_vec();
    bytes.extend_from_slice(body);
    bytes.resize(512 + body.len().div_ceil(512) * 512, 0);
    bytes
}

fn pax_record(key: &str, value: &str) -> Vec<u8> {
    let suffix = format!(" {key}={value}\n");
    let mut length = suffix.len() + 1;
    while length != suffix.len() + length.to_string().len() {
        length = suffix.len() + length.to_string().len();
    }
    format!("{length}{suffix}").into_bytes()
}

struct Source<'a> {
    bytes: &'a [u8],
    position: Rc<Cell<usize>>,
    request: Rc<Cell<usize>>,
    calls: Rc<Cell<usize>>,
}

impl Read for Source<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.calls.set(self.calls.get() + 1);
        self.request.set(output.len());
        let start = self.position.get();
        let length = output.len().min(self.bytes.len() - start);
        output[..length].copy_from_slice(&self.bytes[start..start + length]);
        self.position.set(start + length);
        Ok(length)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Member {
    path: String,
    kind: u8,
    size: u64,
    mode: u32,
    offset: u64,
}

impl From<TarMember> for Member {
    fn from(member: TarMember) -> Self {
        Self {
            path: member.path,
            kind: member.entry_type,
            size: member.size,
            mode: member.mode,
            offset: member.offset,
        }
    }
}

fn expected_member(path: &str, kind: u8, size: u64, offset: u64) -> Member {
    Member {
        path: path.into(),
        kind,
        size,
        mode: 0o640,
        offset,
    }
}

#[derive(Debug)]
struct Trace {
    bytes: Vec<u8>,
    members: Vec<Member>,
    attempted: usize,
    error: Option<(ErrorKind, String)>,
}

// Frame lengths describe the fixture's wire format, including separate metadata
// body/padding and the two EOF blocks. Later zero tail has the public 64 KiB cap.
fn drive(
    bytes: &[u8],
    frames: &[usize],
    limits: TarMeterLimits,
    chunk: usize,
    read: bool,
) -> Trace {
    let position = Rc::new(Cell::new(0));
    let request = Rc::new(Cell::new(0));
    let calls = Rc::new(Cell::new(0));
    let source = Source {
        bytes,
        position: position.clone(),
        request: request.clone(),
        calls: calls.clone(),
    };
    let mut meter = TarMetadataMeter::new(source, limits);
    let mut trace = Trace {
        bytes: Vec::new(),
        members: Vec::new(),
        attempted: 0,
        error: None,
    };
    let mut output = vec![0; chunk];
    loop {
        let start = trace.bytes.len();
        let next_end = frames
            .iter()
            .scan(0, |end, length| {
                *end += length;
                Some(*end)
            })
            .find(|end| *end > start);
        let expected_boundary = next_end.map_or(65536, |end| end - start).min(65536).min(
            limits
                .max_decoded_bytes
                .saturating_sub(start as u64)
                .clamp(1, 65536) as usize,
        );
        assert_eq!(
            meter.boundary(),
            expected_boundary,
            "position={start}, chunk={chunk}, read={read}"
        );
        let expected = chunk.min(bytes.len() - start).min(expected_boundary);
        let result = if read {
            let before = calls.get();
            let result = meter.read(&mut output);
            assert_eq!(calls.get(), before + 1);
            assert_eq!(request.get(), chunk.min(expected_boundary));
            trace.attempted = position.get();
            assert_eq!(trace.attempted, start + expected);
            result
        } else if start == bytes.len() {
            meter.finish().map(|()| 0)
        } else {
            trace.attempted = start + expected;
            meter.push(&bytes[start..(start + chunk).min(bytes.len())])
        };
        match result {
            Err(error) => {
                assert!(
                    meter.take_member().is_none(),
                    "failed steps must not emit a member"
                );
                trace.error = Some((error.kind(), error.to_string()));
                return trace;
            }
            Ok(length) => {
                assert_eq!(length, expected);
                if read {
                    assert_eq!(&output[..length], &bytes[start..start + length]);
                }
                trace.bytes.extend_from_slice(&bytes[start..start + length]);
                let boundary = meter.boundary();
                let reads = calls.get();
                assert_eq!(meter.push(&[]).unwrap(), 0);
                assert_eq!(meter.read(&mut []).unwrap(), 0);
                assert_eq!(calls.get(), reads, "empty reads must not touch the source");
                assert_eq!(meter.boundary(), boundary);
                // Empty operations must also preserve a just-emitted, undrained member.
                if let Some(member) = meter.take_member() {
                    trace.members.push(member.into());
                }
                assert!(meter.take_member().is_none());
                if length == 0 {
                    meter.finish().unwrap();
                    return trace;
                }
            }
        }
    }
}

fn failure(
    bytes: &[u8],
    frames: &[usize],
    limits: TarMeterLimits,
    kind: ErrorKind,
    message: &str,
    last_frame: Option<(usize, usize)>,
    expected_members: &[Member],
) {
    for chunk in CHUNKS {
        for read in [false, true] {
            let trace = drive(bytes, frames, limits, chunk, read);
            assert_eq!(
                trace.error,
                Some((kind, message.to_owned())),
                "chunk={chunk}, read={read}"
            );
            let (accepted, attempted) = last_frame
                .map_or((bytes.len(), bytes.len()), |(start, length)| {
                    (start + (length - 1) / chunk * chunk, start + length)
                });
            assert_eq!(
                trace.bytes.len(),
                accepted,
                "returned bytes, chunk={chunk}, read={read}"
            );
            assert_eq!(
                trace.attempted, attempted,
                "attempted bytes, chunk={chunk}, read={read}"
            );
            assert_eq!(trace.bytes, bytes[..accepted]);
            assert_eq!(
                trace.members.as_slice(),
                expected_members,
                "members, chunk={chunk}, read={read}"
            );
        }
    }
}

#[test]
fn public_boundaries_preserve_pax_gnu_order_offsets_and_pending_members() {
    for (raw_size, effective_size) in [(1_u64, 700_usize), (700, 1), (700, 0)] {
        let metadata = [
            pax_record("path", "pax/value"),
            pax_record("size", &effective_size.to_string()),
        ]
        .concat();
        let body = vec![b'p'; effective_size];
        let padded = effective_size.div_ceil(512) * 512;
        let bytes = [
            entry("pax", b'x', metadata.len() as u64, &metadata),
            entry("raw", b'0', raw_size, &body),
            entry("long-name", b'L', 9, b"gnu/name\0"),
            entry("long-link", b'K', 7, b"target\0"),
            entry("raw-link", b'2', 0, b""),
            entry("last", b'0', 3, b"end"),
            vec![0; 1024],
        ]
        .concat();
        let mut frames = vec![512, metadata.len(), 512 - metadata.len(), 512];
        if padded != 0 {
            frames.push(padded);
        }
        frames.extend([512, 9, 503, 512, 7, 505, 512, 512, 512, 512, 512]);
        assert_eq!(frames.iter().sum::<usize>(), bytes.len());
        let expected = vec![
            Member {
                path: "pax/value".into(),
                kind: b'0',
                size: effective_size as u64,
                mode: 0o640,
                offset: 1536,
            },
            Member {
                path: "gnu/name".into(),
                kind: b'2',
                size: 0,
                mode: 0o640,
                offset: (4096 + padded) as u64,
            },
            Member {
                path: "last".into(),
                kind: b'0',
                size: 3,
                mode: 0o640,
                offset: (4608 + padded) as u64,
            },
        ];
        for chunk in CHUNKS {
            for read in [false, true] {
                let trace = drive(&bytes, &frames, limits(), chunk, read);
                assert!(trace.error.is_none(), "{trace:?}");
                assert_eq!(trace.bytes, bytes);
                assert_eq!(trace.members, expected);
                assert_eq!(trace.attempted, bytes.len());
                assert_eq!(&bytes[1536..1536 + effective_size], body);
                let last = trace.members[2].offset as usize;
                assert_eq!(&trace.bytes[last..last + 3], b"end");
            }
        }
    }
}

#[test]
fn decoded_edges_include_large_data_padding_eof_and_zero_tails() {
    let bytes = [
        entry("large", b'0', 65537, &vec![b'd'; 65537]),
        vec![0; 1024],
    ]
    .concat();
    let frames = [512, 66048, 512, 512];
    assert_eq!(bytes.len(), 67584);
    for ceiling in [0, 1, 511, 512, 513, 66048, 67583] {
        let members = if ceiling >= 512 {
            vec![expected_member("large", b'0', 65537, 512)]
        } else {
            vec![]
        };
        failure(
            &bytes,
            &frames,
            TarMeterLimits {
                max_decoded_bytes: ceiling,
                ..limits()
            },
            ErrorKind::Other,
            "archive-decoded-size-exceeds-limit",
            Some((ceiling as usize, 1)),
            &members,
        );
    }
    for tail in [0, 65537] {
        let complete = [bytes.clone(), vec![0; tail]].concat();
        for chunk in CHUNKS {
            for read in [false, true] {
                let trace = drive(
                    &complete,
                    &frames,
                    TarMeterLimits {
                        max_decoded_bytes: complete.len() as u64,
                        ..limits()
                    },
                    chunk,
                    read,
                );
                assert!(trace.error.is_none(), "{trace:?}");
                assert_eq!(trace.bytes, complete);
                assert_eq!(trace.members.len(), 1);
                assert_eq!(trace.members[0].offset, 512);
                assert_eq!(trace.members[0].size, 65537);
            }
        }
    }
    for (tail, kind, message) in [
        (0, ErrorKind::Other, "archive-decoded-size-exceeds-limit"),
        (
            1,
            ErrorKind::InvalidData,
            "archive-header-invalid: nonzero data after TAR EOF",
        ),
    ] {
        let trailing = [vec![0; 1024], vec![tail]].concat();
        failure(
            &trailing,
            &[512, 512],
            TarMeterLimits {
                max_decoded_bytes: 1024,
                ..limits()
            },
            kind,
            message,
            Some((1024, 1)),
            &[],
        );
    }
}

#[test]
fn metadata_member_and_utf8_manifest_limits_stop_at_the_rejected_header() {
    let metadata = pax_record("path", "pkg/caf\u{e9}");
    let bytes = [
        entry("pax", b'x', metadata.len() as u64, &metadata),
        entry("raw", b'0', 0, b""),
        entry("next", b'0', 0, b""),
        vec![0; 1024],
    ]
    .concat();
    let frames = [
        512,
        metadata.len(),
        512 - metadata.len(),
        512,
        512,
        512,
        512,
    ];
    let exact = TarMeterLimits {
        max_entries: 2,
        max_meta_entry_bytes: metadata.len() as u64,
        max_manifest_bytes: 154,
        max_decoded_bytes: 3072,
        ..limits()
    };
    assert_eq!(64 + 2 * "pkg/caf\u{e9}".len(), 82);
    for chunk in CHUNKS {
        for read in [false, true] {
            let trace = drive(&bytes, &frames, exact, chunk, read);
            assert!(trace.error.is_none(), "{trace:?}");
            assert_eq!(trace.bytes, bytes);
            assert_eq!(
                trace
                    .members
                    .iter()
                    .map(|m| (m.path.as_str(), m.offset))
                    .collect::<Vec<_>>(),
                [("pkg/caf\u{e9}", 1536), ("next", 2048)]
            );
        }
    }
    failure(
        &bytes,
        &frames,
        TarMeterLimits {
            max_meta_entry_bytes: metadata.len() as u64 - 1,
            max_entries: 0,
            ..exact
        },
        ErrorKind::InvalidData,
        "archive-meta-entry-size-exceeds-limit",
        Some((0, 512)),
        &[],
    );
    for (entries, manifest, end, message) in [
        (0, 0, 1536, "archive-entry-count-exceeds-limit"),
        (1, 154, 2048, "archive-entry-count-exceeds-limit"),
        (2, 81, 1536, "archive-manifest-size-exceeds-limit"),
        (2, 82, 2048, "archive-manifest-size-exceeds-limit"),
        (2, 153, 2048, "archive-manifest-size-exceeds-limit"),
    ] {
        let members = if end == 2048 {
            vec![expected_member("pkg/caf\u{e9}", b'0', 0, 1536)]
        } else {
            vec![]
        };
        failure(
            &bytes,
            &frames,
            TarMeterLimits {
                max_entries: entries,
                max_manifest_bytes: manifest,
                ..exact
            },
            ErrorKind::Other,
            message,
            Some((end - 512, 512)),
            &members,
        );
    }
    let aligned_metadata = pax_record("uname", &"u".repeat(501));
    assert_eq!(aligned_metadata.len(), 512);
    let aligned = [
        entry("pax", b'x', 512, &aligned_metadata),
        entry("zero", b'0', 0, b""),
        vec![0; 1024],
    ]
    .concat();
    let aligned_limits = TarMeterLimits {
        max_meta_entry_bytes: 512,
        max_entries: 1,
        max_manifest_bytes: 72,
        max_decoded_bytes: 2560,
        ..limits()
    };
    for chunk in CHUNKS {
        for read in [false, true] {
            let trace = drive(&aligned, &[512; 5], aligned_limits, chunk, read);
            assert!(trace.error.is_none(), "{trace:?}");
            assert_eq!(trace.bytes, aligned);
            assert_eq!(trace.members.len(), 1);
            assert_eq!(trace.members[0].path, "zero");
            assert_eq!(trace.members[0].offset, 1536);
        }
    }
    failure(
        &aligned,
        &[512; 5],
        TarMeterLimits {
            max_meta_entry_bytes: 511,
            ..aligned_limits
        },
        ErrorKind::InvalidData,
        "archive-meta-entry-size-exceeds-limit",
        Some((0, 512)),
        &[],
    );
}

fn sparse(main_flag: u8, extension_flags: &[u8]) -> Vec<u8> {
    let mut main = header("sparse", b'S', 513);
    main.as_mut_bytes()[482] = main_flag;
    main.set_cksum();
    let mut bytes = main.as_bytes().to_vec();
    for flag in extension_flags {
        let mut extension = [0; 512];
        extension[504] = *flag;
        bytes.extend_from_slice(&extension);
    }
    bytes.extend_from_slice(&[b'z'; 1024]);
    bytes
}

#[test]
fn sparse_flags_meter_complete_extensions_before_terminal_errors() {
    for (main, extensions, limit, end, message) in [
        (
            0,
            &[][..],
            0,
            512,
            "archive-header-invalid: GNU sparse entries are not supported",
        ),
        (
            2,
            &[][..],
            0,
            512,
            "archive-header-invalid: GNU sparse extension flag is not 0 or 1",
        ),
        (
            1,
            &[0][..],
            511,
            1024,
            "archive-meta-entry-size-exceeds-limit",
        ),
        (
            1,
            &[0][..],
            512,
            1024,
            "archive-header-invalid: GNU sparse entries are not supported",
        ),
        (
            1,
            &[2][..],
            511,
            1024,
            "archive-meta-entry-size-exceeds-limit",
        ),
        (
            1,
            &[2][..],
            512,
            1024,
            "archive-header-invalid: GNU sparse extension flag is not 0 or 1",
        ),
        (
            1,
            &[1, 0][..],
            512,
            1536,
            "archive-meta-entry-size-exceeds-limit",
        ),
        (
            1,
            &[1, 0][..],
            1024,
            1536,
            "archive-header-invalid: GNU sparse entries are not supported",
        ),
    ] {
        failure(
            &sparse(main, extensions),
            &[512, 512, 512],
            TarMeterLimits {
                max_meta_entry_bytes: limit,
                max_entries: 0,
                max_manifest_bytes: 0,
                ..limits()
            },
            ErrorKind::InvalidData,
            message,
            Some((end - 512, 512)),
            &[],
        );
    }
    let metadata = pax_record("size", "0");
    let bytes = [
        entry("pax", b'x', metadata.len() as u64, &metadata),
        sparse(1, &[0]),
    ]
    .concat();
    failure(
        &bytes,
        &[512, metadata.len(), 512 - metadata.len(), 512, 512],
        TarMeterLimits {
            max_meta_entry_bytes: 511,
            ..limits()
        },
        ErrorKind::InvalidData,
        "archive-meta-entry-size-exceeds-limit",
        Some((1536, 512)),
        &[],
    );
}

#[test]
fn finish_reports_truncation_and_pending_metadata_precedence_at_physical_eof() {
    let metadata = pax_record("path", "name");
    let pax = entry("pax", b'x', metadata.len() as u64, &metadata);
    let gnu = entry("gnu", b'L', 5, b"name\0");
    let data = entry("file", b'0', 3, b"abc");
    let sparse = sparse(1, &[1]);
    for (bytes, frames, message, members) in [
        (vec![], vec![], "missing two-block TAR EOF", vec![]),
        (
            vec![0; 512],
            vec![512, 512],
            "missing two-block TAR EOF",
            vec![],
        ),
        (
            vec![0; 1023],
            vec![512, 512],
            "truncated TAR header",
            vec![],
        ),
        (
            data[..511].to_vec(),
            vec![512],
            "truncated TAR header",
            vec![],
        ),
        (
            data[..514].to_vec(),
            vec![512, 512],
            "truncated TAR entry data",
            vec![expected_member("file", b'0', 3, 512)],
        ),
        (
            data[..1023].to_vec(),
            vec![512, 512],
            "truncated TAR entry data",
            vec![expected_member("file", b'0', 3, 512)],
        ),
        (
            pax[..512 + metadata.len() - 1].to_vec(),
            vec![512, metadata.len()],
            "truncated PAX/GNU metadata",
            vec![],
        ),
        (
            pax[..1023].to_vec(),
            vec![512, metadata.len(), 512 - metadata.len()],
            "dangling PAX metadata",
            vec![],
        ),
        (
            pax,
            vec![512, metadata.len(), 512 - metadata.len()],
            "dangling PAX metadata",
            vec![],
        ),
        (
            gnu[..513].to_vec(),
            vec![512, 5, 507],
            "dangling GNU metadata",
            vec![],
        ),
        (gnu, vec![512, 5, 507], "dangling GNU metadata", vec![]),
        (
            sparse[..1023].to_vec(),
            vec![512, 512],
            "truncated GNU sparse header",
            vec![],
        ),
    ] {
        failure(
            &bytes,
            &frames,
            TarMeterLimits {
                max_decoded_bytes: bytes.len() as u64,
                ..limits()
            },
            ErrorKind::InvalidData,
            &format!("archive-header-invalid: {message}"),
            None,
            &members,
        );
    }
}

#[test]
fn malformed_frames_and_eof_precedence_preserve_exact_failure_positions() {
    let mut bad_header = header("file", b'0', 0).as_bytes().to_vec();
    bad_header[0] ^= 1;
    failure(
        &bad_header,
        &[512],
        limits(),
        ErrorKind::InvalidData,
        "archive-header-invalid: checksum failure",
        Some((0, 512)),
        &[],
    );
    failure(
        &bad_header,
        &[512],
        TarMeterLimits {
            max_decoded_bytes: 511,
            ..limits()
        },
        ErrorKind::Other,
        "archive-decoded-size-exceeds-limit",
        Some((511, 1)),
        &[],
    );
    for (kind, body, message) in [
        (
            b'x',
            b"bad".as_slice(),
            "archive-header-invalid: unsupported or malformed PAX metadata",
        ),
        (
            b'L',
            b"a\0b".as_slice(),
            "archive-header-invalid: empty GNU name or embedded NUL",
        ),
        (
            b'L',
            b"\xffxy".as_slice(),
            "archive-header-invalid: GNU name is not valid UTF-8",
        ),
    ] {
        failure(
            &entry("metadata", kind, 3, body),
            &[512, 3, 509],
            limits(),
            ErrorKind::InvalidData,
            message,
            Some((512, 3)),
            &[],
        );
    }
    failure(
        &[vec![0; 512], bad_header].concat(),
        &[512, 512],
        limits(),
        ErrorKind::InvalidData,
        "archive-header-invalid: nonzero header after one TAR zero block",
        Some((512, 512)),
        &[],
    );
    failure(
        &[vec![0; 1024], vec![1]].concat(),
        &[512, 512],
        limits(),
        ErrorKind::InvalidData,
        "archive-header-invalid: nonzero data after TAR EOF",
        Some((1024, 1)),
        &[],
    );
    let metadata = pax_record("path", "name");
    for (prefix, frames, message) in [
        (
            entry("pax", b'x', metadata.len() as u64, &metadata),
            vec![512, metadata.len(), 512 - metadata.len(), 512],
            "dangling PAX metadata",
        ),
        (
            entry("gnu", b'L', 5, b"name\0"),
            vec![512, 5, 507, 512],
            "dangling GNU metadata",
        ),
    ] {
        failure(
            &[prefix, vec![0; 1024]].concat(),
            &frames,
            limits(),
            ErrorKind::InvalidData,
            &format!("archive-header-invalid: {message}"),
            Some((1024, 512)),
            &[],
        );
    }
}
