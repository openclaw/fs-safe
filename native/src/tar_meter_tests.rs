use super::*;
use std::io::Cursor;

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
    TarMetadataMeter::new(Chunked { inner: Cursor::new(bytes), chunk }, limit)
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
