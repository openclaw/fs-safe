use crate::tar_pax::{LocalPax, parse_local_pax};
use std::io::{self, Read};

pub const INVALID_HEADER: &str = "archive-header-invalid";
pub const META_LIMIT: &str = "archive-meta-entry-size-exceeds-limit";

enum MeterState {
    Header,
    Data {
        remaining: u64,
    },
    Pax {
        body: Vec<u8>,
        used: usize,
        padding: u64,
    },
    SparseHeader {
        data_remaining: u64,
        meta_bytes: u64,
    },
}

pub struct TarMetadataMeter<R> {
    inner: R,
    max_meta_entry_bytes: u64,
    state: MeterState,
    block: [u8; 512],
    block_len: usize,
    pending_pax: Option<LocalPax>,
    pending_gnu: bool,
}

impl<R> TarMetadataMeter<R> {
    pub fn new(inner: R, max_meta_entry_bytes: u64) -> Self {
        Self {
            inner,
            max_meta_entry_bytes,
            state: MeterState::Header,
            block: [0; 512],
            block_len: 0,
            pending_pax: None,
            pending_gnu: false,
        }
    }

    fn invalid(message: &str) -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{INVALID_HEADER}: {message}"),
        )
    }

    fn meta_limit() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, META_LIMIT)
    }

    fn padded_size(size: u64) -> io::Result<u64> {
        size.checked_add(511)
            .map(|value| value / 512 * 512)
            .ok_or_else(|| Self::invalid("entry size overflows TAR padding"))
    }

    fn parse_size(field: &[u8; 12]) -> io::Result<u64> {
        if field[0] & 0x80 != 0 {
            if field[0] != 0x80 || field[1..4].iter().any(|byte| *byte != 0) {
                return Err(Self::invalid("base-256 size is negative or overflows u64"));
            }
            let mut value = 0_u64;
            for byte in &field[4..] {
                value = value
                    .checked_shl(8)
                    .ok_or_else(|| Self::invalid("base-256 size overflow"))?;
                value |= *byte as u64;
            }
            return Ok(value);
        }
        let end = field
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(field.len());
        let text = std::str::from_utf8(&field[..end])
            .map_err(|_| Self::invalid("size is not ASCII octal"))?
            .trim();
        if text.is_empty() || !text.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
            return Err(Self::invalid("size is not valid octal"));
        }
        u64::from_str_radix(text, 8).map_err(|_| Self::invalid("octal size overflow"))
    }

    fn finish_header(&mut self) -> io::Result<()> {
        if self.block.iter().all(|byte| *byte == 0) {
            if self.pending_pax.is_some() {
                return Err(Self::invalid("dangling PAX metadata"));
            }
            self.pending_gnu = false;
            self.state = MeterState::Header;
            self.block_len = 0;
            return Ok(());
        }
        let name_end = self.block[..100]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(100);
        if name_end == 0 {
            return Err(Self::invalid("entry path is empty"));
        }
        if self.block[156] != b'5' && self.block[..name_end].last() == Some(&b'/') {
            return Err(Self::invalid(
                "non-directory entry path ends with a separator",
            ));
        }
        let mut size = Self::parse_size(self.block[124..136].try_into().unwrap())?;
        let entry_type = self.block[156];
        if matches!(entry_type, b'x' | b'g' | b'L' | b'K' | b'X' | b'N')
            && size > self.max_meta_entry_bytes
        {
            return Err(Self::meta_limit());
        }
        if matches!(entry_type, b'g' | b'X' | b'N') {
            return Err(Self::invalid(
                "global/old PAX and old GNU metadata are not supported",
            ));
        }
        if entry_type == b'x' {
            if self.pending_pax.is_some() || self.pending_gnu || size == 0 {
                return Err(Self::invalid("empty, repeated or mixed PAX metadata"));
            }
            let magic = &self.block[257..265];
            if magic != b"ustar\x0000" && magic != b"ustar  \0" {
                return Err(Self::invalid("unrecognized PAX header format"));
            }
            let padded = Self::padded_size(size)?;
            let length = usize::try_from(size).map_err(|_| Self::meta_limit())?;
            let mut body = Vec::new();
            body.try_reserve_exact(length)
                .map_err(|_| Self::meta_limit())?;
            body.resize(length, 0);
            self.state = MeterState::Pax {
                body,
                used: 0,
                padding: padded - size,
            };
            self.block_len = 0;
            return Ok(());
        }
        // Preserve sparse extension metering before reporting unsupported PAX.
        if entry_type != b'S'
            && let Some(pax) = self.pending_pax.take()
        {
            size = pax.member_size(entry_type, size, &self.block)?;
            if Self::padded_size(size)? > 9_007_199_254_740_991 {
                return Err(Self::invalid("entry padding exceeds the safe integer range"));
            }
        }
        self.pending_gnu = matches!(entry_type, b'L' | b'K');
        let padded = Self::padded_size(size)?;
        self.state = if entry_type == b'S' {
            match self.block[482] {
                0 => return Err(Self::invalid("GNU sparse entries are not supported")),
                1 => MeterState::SparseHeader {
                    data_remaining: padded,
                    meta_bytes: 0,
                },
                _ => return Err(Self::invalid("GNU sparse extension flag is not 0 or 1")),
            }
        } else {
            MeterState::Data { remaining: padded }
        };
        self.block_len = 0;
        if matches!(self.state, MeterState::Data { remaining: 0 }) {
            self.state = MeterState::Header;
        }
        Ok(())
    }

    fn finish_sparse_header(&mut self, data_remaining: u64, meta_bytes: u64) -> io::Result<()> {
        let metered = meta_bytes.checked_add(512).ok_or_else(Self::meta_limit)?;
        if metered > self.max_meta_entry_bytes {
            return Err(Self::meta_limit());
        }
        self.state = match self.block[504] {
            0 => return Err(Self::invalid("GNU sparse entries are not supported")),
            1 => MeterState::SparseHeader {
                data_remaining,
                meta_bytes: metered,
            },
            _ => return Err(Self::invalid("GNU sparse extension flag is not 0 or 1")),
        };
        self.block_len = 0;
        Ok(())
    }

    fn meter(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut offset = 0;
        while offset < bytes.len() {
            match self.state {
                MeterState::Pax {
                    ref mut body,
                    ref mut used,
                    padding,
                } => {
                    let take = (body.len() - *used).min(bytes.len() - offset);
                    body[*used..*used + take].copy_from_slice(&bytes[offset..offset + take]);
                    *used += take;
                    offset += take;
                    if *used == body.len() {
                        self.pending_pax = Some(parse_local_pax(body)?);
                        self.state = if padding == 0 {
                            MeterState::Header
                        } else {
                            MeterState::Data { remaining: padding }
                        };
                    }
                }
                MeterState::Header => {
                    let take = (512 - self.block_len).min(bytes.len() - offset);
                    self.block[self.block_len..self.block_len + take]
                        .copy_from_slice(&bytes[offset..offset + take]);
                    self.block_len += take;
                    offset += take;
                    if self.block_len == 512 {
                        self.finish_header()?;
                    }
                }
                MeterState::Data { remaining } => {
                    let take = remaining.min((bytes.len() - offset) as u64);
                    offset += take as usize;
                    let remaining = remaining - take;
                    self.state = if remaining == 0 {
                        MeterState::Header
                    } else {
                        MeterState::Data { remaining }
                    };
                }
                MeterState::SparseHeader {
                    data_remaining,
                    meta_bytes,
                } => {
                    let take = (512 - self.block_len).min(bytes.len() - offset);
                    self.block[self.block_len..self.block_len + take]
                        .copy_from_slice(&bytes[offset..offset + take]);
                    self.block_len += take;
                    offset += take;
                    if self.block_len == 512 {
                        self.finish_sparse_header(data_remaining, meta_bytes)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn check_eof(&self) -> io::Result<()> {
        if self.pending_pax.is_some() {
            return Err(Self::invalid("dangling PAX metadata"));
        }
        match self.state {
            MeterState::Header if self.block_len == 0 => Ok(()),
            MeterState::Header => Err(Self::invalid("truncated TAR header")),
            MeterState::Data { .. } => Err(Self::invalid("truncated TAR entry data")),
            MeterState::Pax { .. } => Err(Self::invalid("truncated PAX metadata")),
            MeterState::SparseHeader { .. } => Err(Self::invalid("truncated GNU sparse header")),
        }
    }
}

impl<R: Read> Read for TarMetadataMeter<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(output)?;
        if read == 0 {
            self.check_eof()?;
            return Ok(0);
        }
        self.meter(&output[..read])?;
        Ok(read)
    }
}

#[cfg(test)]
#[path = "tar_meter_tests.rs"]
mod pax_tests;

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use super::*;

    fn header(entry_type: u8, size: u64, base_256: bool) -> [u8; 512] {
        let mut header = [0_u8; 512];
        header[0] = b'x';
        header[156] = entry_type;
        header[257..265].copy_from_slice(b"ustar\x0000");
        if base_256 {
            header[124] = 0x80;
            header[128..136].copy_from_slice(&size.to_be_bytes());
        } else {
            let encoded = format!("{:011o}\0", size);
            header[124..136].copy_from_slice(encoded.as_bytes());
        }
        header
    }

    fn consume(bytes: Vec<u8>, limit: u64) -> io::Result<Vec<u8>> {
        let mut output = Vec::new();
        TarMetadataMeter::new(Cursor::new(bytes), limit).read_to_end(&mut output)?;
        Ok(output)
    }

    #[test]
    fn meters_octal_and_base_256_metadata_before_forwarding() {
        for base_256 in [false, true] {
            let bytes = [header(b'x', 513, base_256).as_slice(), &vec![0; 1024]].concat();
            let error = consume(bytes, 512).unwrap_err();
            assert!(error.to_string().contains(META_LIMIT));
        }
    }

    #[test]
    fn rejects_malformed_in_limit_pax() {
        let bytes = [header(b'x', 8, false).as_slice(), &vec![0; 512]].concat();
        let error = consume(bytes, 1024).unwrap_err();
        assert!(error.to_string().contains(INVALID_HEADER));
        assert!(error.to_string().contains("PAX metadata"));
    }

    #[test]
    fn meters_chained_sparse_extension_blocks() {
        let mut main = header(b'S', 0, false);
        main[482] = 1;
        let mut first = [0_u8; 512];
        first[504] = 1;
        let second = [0_u8; 512];
        let error = consume([main.as_slice(), &first, &second].concat(), 512).unwrap_err();
        assert!(error.to_string().contains(META_LIMIT));
    }

    #[test]
    fn rejects_random_invalid_size_headers_and_truncation() {
        let mut seed = 0x1234_5678_u64;
        for _ in 0..256 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let mut block = header(b'0', 0, false);
            block[124..136].fill(((seed >> 32) as u8) | 0x08);
            assert!(consume(block.to_vec(), 1024).is_err());
        }
        assert!(
            consume(vec![0_u8; 511], 1024)
                .unwrap_err()
                .to_string()
                .contains(INVALID_HEADER)
        );
    }

    #[test]
    fn rejects_base_256_sizes_with_nonzero_high_order_bytes() {
        for offset in 1..4 {
            let mut block = header(b'0', 0, true);
            block[124 + offset] = 1;
            let error = consume(block.to_vec(), 1024).unwrap_err();
            assert!(error.to_string().contains(INVALID_HEADER));
            assert!(error.to_string().contains("overflows u64"));
        }
    }

    #[test]
    fn rejects_an_empty_entry_path() {
        let mut block = header(b'0', 0, false);
        block[..100].fill(0);
        let error = consume(block.to_vec(), 1024).unwrap_err();
        assert!(error.to_string().contains(INVALID_HEADER));
        assert!(error.to_string().contains("entry path is empty"));
    }
}
