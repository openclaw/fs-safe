use super::*;
use std::io::Write;
use std::sync::atomic::AtomicUsize;

struct Source {
    inner: Cursor<Vec<u8>>,
    max_chunk: usize,
    reads: Arc<AtomicUsize>,
}

impl Read for Source {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        assert!(output.len() <= 65536, "file read-ahead must stay bounded");
        self.reads.fetch_add(1, Ordering::Relaxed);
        let length = output.len().min(self.max_chunk);
        self.inner.read(&mut output[..length])
    }
}

impl Seek for Source {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(position)
    }
}

fn fixture(count: usize) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for index in 0..count {
        let mut header = tar::Header::new_ustar();
        header.set_size(3);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, format!("package/file-{index}.txt"), b"abc".as_slice()).unwrap();
    }
    builder.into_inner().unwrap()
}

fn reader(bytes: Vec<u8>, chunk: usize, buffered: bool, cancelled: Arc<AtomicBool>)
    -> (TarMetadataMeter<Box<dyn Read + Send>>, Arc<AtomicUsize>)
{
    let reads = Arc::new(AtomicUsize::new(0));
    let source = Source { inner: Cursor::new(bytes), max_chunk: chunk, reads: Arc::clone(&reads) };
    let limits = TarMeterLimits { windows_paths: cfg!(windows), max_entries: 10_000,
        max_meta_entry_bytes: 1024 * 1024, max_decoded_bytes: 64 * 1024 * 1024,
        max_manifest_bytes: MAX_MANIFEST_BYTES };
    (open_tar_source(source, ArchiveFormat::Tar, cancelled, limits, buffered).unwrap(), reads)
}

#[test]
fn small_members_share_bounded_file_reads_and_keep_their_payload_ranges() {
    let bytes = fixture(1000);
    for buffered in [false, true] {
        let (reader, reads) = reader(bytes.clone(), usize::MAX, buffered, Arc::new(AtomicBool::new(false)));
        let members = inspect_tar_reader(reader).unwrap();
        assert_eq!(members.len(), 1000);
        for (index, member) in members.into_iter().enumerate() {
            assert_eq!(member.path, format!("package/file-{index}.txt"));
            assert_eq!(member.kind, "file");
            assert_eq!(member.mode, 0o644);
            assert_eq!(member.size, 3);
            assert_eq!(member.offset, (index * 1024 + 512) as u64);
        }
        let count = reads.load(Ordering::Relaxed);
        if buffered { assert!(count <= bytes.len().div_ceil(65536) + 2, "{count} reads"); }
        else { assert!(count > 2000, "control must exercise boundary-sized physical reads"); }
    }
}

#[test]
fn cached_payload_does_not_delay_cancellation_until_the_next_file_read() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let (mut reader, reads) = reader(fixture(2), usize::MAX, true, Arc::clone(&cancelled));
    assert_eq!(reader.read(&mut [0; 512]).unwrap(), 512);
    assert_eq!(reader.take_member().unwrap().path, "package/file-0.txt");
    let count = reads.load(Ordering::Relaxed);
    cancelled.store(true, Ordering::Relaxed);
    assert!(reader.read(&mut [0; 512]).unwrap_err().to_string().contains("archive operation aborted"));
    assert_eq!(reads.load(Ordering::Relaxed), count);
}

#[test]
fn read_ahead_preserves_short_reads_and_later_framing_errors() {
    let valid = fixture(2);
    let mut checksum = valid.clone();
    checksum[1024 + 148..1024 + 156].fill(b'0');
    let mut tail = valid.clone();
    tail.write_all(&[1]).unwrap();
    for chunk in [1, 7, 65536] {
        let cancelled = || Arc::new(AtomicBool::new(false));
        assert_eq!(inspect_tar_reader(reader(valid.clone(), chunk, true, cancelled()).0).unwrap().len(), 2);
        for (bytes, expected) in [(&checksum, "checksum failure"), (&tail, "nonzero data after TAR EOF"),
            (&valid[..1536].to_vec(), "truncated TAR entry data")] {
            let error = inspect_tar_reader(reader(bytes.clone(), chunk, true, cancelled()).0).unwrap_err();
            assert!(error.reason.contains(expected), "chunk={chunk}: {error}");
        }
    }
}
