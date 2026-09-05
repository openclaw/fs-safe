use std::io::{self, BufRead, BufReader, Read};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use flate2::bufread::GzDecoder;

/// Decode every gzip member, then admit only zero container padding to physical EOF.
/// BufRead preserves input following the validated member trailer.
pub(crate) struct GzipContainer<R> {
    member: Option<GzDecoder<BufReader<R>>>,
    cancelled: Arc<AtomicBool>,
    failed: bool,
}

impl<R: Read> GzipContainer<R> {
    pub(crate) fn new(reader: R, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            member: Some(GzDecoder::new(BufReader::with_capacity(65536, reader))),
            cancelled,
            failed: false,
        }
    }

    fn check_cancelled(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(io::Error::other("archive operation aborted"))
        } else { Ok(()) }
    }

    fn read_member_or_padding(&mut self, output: &mut [u8]) -> io::Result<usize> {
        loop {
            self.check_cancelled()?;
            let Some(member) = &mut self.member else { return Ok(0); };
            let read = member.read(output)?;
            if read != 0 { return Ok(read); }
            // GzDecoder reaches EOF only after checking the complete CRC32/ISIZE trailer.
            let mut input = self.member.take().unwrap().into_inner();
            match input.fill_buf()?.first() {
                None => return Ok(0),
                Some(0) => {
                    loop {
                        self.check_cancelled()?;
                        let bytes = input.fill_buf()?;
                        if bytes.is_empty() { return Ok(0); }
                        if bytes.iter().any(|byte| *byte != 0) {
                            return Err(io::Error::other("archive-header-invalid: nonzero gzip container padding"));
                        }
                        let length = bytes.len();
                        input.consume(length);
                    }
                }
                // A following member must validate normally; arbitrary junk is never suppressed.
                Some(_) => self.member = Some(GzDecoder::new(input)),
            }
        }
    }
}

impl<R: Read> Read for GzipContainer<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.failed { return Err(io::Error::other("gzip container already failed")); }
        if output.is_empty() { return Ok(0); }
        let result = self.read_member_or_padding(output);
        if result.is_err() { self.failed = true; self.member = None; }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // Python stdlib gzip.compress(b"abc", mtime=0), with known CRC32/ISIZE.
    const MEMBER: &[u8] = &[31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 75, 76, 74, 6, 0, 194, 65, 36, 53, 3, 0, 0, 0];
    struct Chunked {
        source: Cursor<Vec<u8>>,
        chunk: usize,
        cancel_at: u64,
        cancelled: Arc<AtomicBool>,
    }
    impl Read for Chunked {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            let length = output.len().min(self.chunk);
            let read = self.source.read(&mut output[..length])?;
            if self.source.position() >= self.cancel_at { self.cancelled.store(true, Ordering::Relaxed); }
            Ok(read)
        }
    }
    fn decoder(bytes: Vec<u8>, chunk: usize, cancel_at: u64) -> GzipContainer<Chunked> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let source = Chunked { source: Cursor::new(bytes), chunk, cancel_at, cancelled: Arc::clone(&cancelled) };
        GzipContainer::new(source, cancelled)
    }
    #[test]
    fn preserves_member_boundaries_with_short_reads_and_complete_padding() {
        for chunk in [1, 7, 511, 65536] {
            for padding in [0, 1, 511, 512, 513, 10240 - 2 * MEMBER.len()] {
                let bytes = [MEMBER, MEMBER, &vec![0; padding]].concat();
                let mut output = Vec::new();
                decoder(bytes, chunk, u64::MAX).read_to_end(&mut output).unwrap();
                assert_eq!(output, b"abcabc");
            }
        }
    }
    #[test]
    fn padding_never_masks_a_bad_trailer_following_member_or_nonzero_tail() {
        let mut corrupt = MEMBER.to_vec();
        corrupt[MEMBER.len() - 8] ^= 1;
        for bytes in [
            [corrupt.as_slice(), &[0; 10240]].concat(),
            [MEMBER, &[0; 513], &[1]].concat(),
            [MEMBER, &[31, 139]].concat(),
            [MEMBER, corrupt.as_slice()].concat(),
            [MEMBER, &[0], MEMBER].concat(),
        ] {
            for chunk in [1, 7, 65536] {
                let mut reader = decoder(bytes.clone(), chunk, u64::MAX);
                assert!(reader.read_to_end(&mut Vec::new()).is_err());
                assert!(reader.read(&mut [0; 1]).is_err());
            }
        }
    }
    #[test]
    fn cancellation_interrupts_physical_padding_drain() {
        let bytes = [MEMBER, &[0; 10240]].concat();
        let mut reader = decoder(bytes, 1, MEMBER.len() as u64 + 4);
        let error = reader.read_to_end(&mut Vec::new()).unwrap_err();
        assert!(error.to_string().contains("archive operation aborted"));
    }
}
