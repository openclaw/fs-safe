use std::collections::HashSet;
use std::io;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub struct LocalPax {
    size: Option<u64>,
    path_trailing_separator: bool,
    linkpath: bool,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "archive-header-invalid: unsupported or malformed PAX metadata",
    )
}

fn decimal(bytes: &[u8]) -> io::Result<u64> {
    if bytes.is_empty() || (bytes.len() > 1 && bytes[0] == b'0') {
        return Err(invalid());
    }
    let mut value = 0_u64;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return Err(invalid());
        }
        value = value
            .checked_mul(10)
            .and_then(|n| n.checked_add((byte - b'0') as u64))
            .filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or_else(invalid)?;
    }
    Ok(value)
}

fn ascii(bytes: &[u8]) -> io::Result<&str> {
    if bytes.is_empty() || bytes.iter().any(|byte| !(0x20..=0x7e).contains(byte)) {
        return Err(invalid());
    }
    std::str::from_utf8(bytes).map_err(|_| invalid())
}

fn timestamp(bytes: &[u8]) -> io::Result<()> {
    let text = ascii(bytes)?;
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, "0"));
    decimal(integer.as_bytes())?;
    if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let value: f64 = text.parse().map_err(|_| invalid())?;
    if value.abs() > 8_640_000_000_000.0 {
        return Err(invalid());
    }
    Ok(())
}

// Keep this byte grammar aligned with src/archive-tar-pax.ts. In particular,
// Rust takes the first duplicate and JS takes the last, so neither is allowed.
pub fn parse_local_pax(body: &[u8]) -> io::Result<LocalPax> {
    if body.is_empty() {
        return Err(invalid());
    }
    let mut result = LocalPax::default();
    let mut keys = HashSet::new();
    let mut offset = 0;
    while offset < body.len() {
        let space = body[offset..]
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(invalid)?;
        let length = decimal(&body[offset..offset + space])?;
        let length = usize::try_from(length).map_err(|_| invalid())?;
        if length > body.len() - offset || length <= space + 3 {
            return Err(invalid());
        }
        let end = offset + length;
        if body[end - 1] != b'\n' {
            return Err(invalid());
        }
        let record = &body[offset + space + 1..end - 1];
        if record.contains(&b'\n') {
            return Err(invalid());
        }
        let equals = record
            .iter()
            .position(|b| *b == b'=')
            .ok_or_else(invalid)?;
        let key = ascii(&record[..equals])?;
        if !key.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || !keys.insert(key)
        {
            return Err(invalid());
        }
        let value = &record[equals + 1..];
        match key {
            "path" => {
                ascii(value)?;
                result.path_trailing_separator = matches!(value.last(), Some(b'/' | b'\\'));
            }
            "linkpath" => {
                ascii(value)?;
                result.linkpath = true;
            }
            "size" => result.size = Some(decimal(value)?),
            "uid" | "gid" => {
                decimal(value)?;
            }
            "uname" | "gname" => {
                ascii(value)?;
            }
            "mtime" | "atime" | "ctime" => timestamp(value)?,
            _ if ["LIBARCHIVE.xattr.", "SCHILY.xattr."]
                .iter()
                .any(|prefix| key.starts_with(prefix) && key.len() > prefix.len()) =>
            {
                // Ignored binary values may contain NUL/non-UTF8, but not LF:
                // tar's numeric lookup stops at any malformed preceding line.
            }
            _ => return Err(invalid()),
        }
        offset = end;
    }
    Ok(result)
}

impl LocalPax {
    pub fn member_size(
        &self,
        entry_type: u8,
        raw_size: u64,
        header: &[u8; 512],
    ) -> io::Result<u64> {
        if !matches!(entry_type, 0 | b'0' | b'1' | b'2' | b'5' | b'7') {
            return Err(invalid());
        }
        let raw_name = raw_text(&header[..100])?;
        let raw_link = raw_text(&header[157..257])?;
        if &header[257..265] == b"ustar\x0000" {
            raw_text(&header[345..500])?;
        }
        let is_link = matches!(entry_type, b'1' | b'2');
        if is_link != !raw_link.is_empty() {
            return Err(invalid());
        }
        let size = self.size.unwrap_or(raw_size);
        if raw_size > MAX_SAFE_INTEGER
            || size > MAX_SAFE_INTEGER
            || (matches!(entry_type, b'1' | b'2' | b'5') && (raw_size != 0 || size != 0))
        {
            return Err(invalid());
        }
        if entry_type != b'5' && (self.path_trailing_separator || raw_name.ends_with('\\')) {
            return Err(invalid());
        }
        if self.linkpath && !is_link {
            return Err(invalid());
        }
        Ok(size)
    }
}

fn raw_text(field: &[u8]) -> io::Result<&str> {
    let end = field.iter().position(|byte| *byte == 0).unwrap_or(field.len());
    if end == 0 {
        Ok("")
    } else {
        ascii(&field[..end])
    }
}
