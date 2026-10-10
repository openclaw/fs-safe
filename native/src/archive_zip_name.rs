use std::borrow::Cow;
use std::io::{Error, ErrorKind, Result};

const CP437_HIGH: [char; 128] = [
    '\u{c7}', '\u{fc}', '\u{e9}', '\u{e2}', '\u{e4}', '\u{e0}', '\u{e5}', '\u{e7}',
    '\u{ea}', '\u{eb}', '\u{e8}', '\u{ef}', '\u{ee}', '\u{ec}', '\u{c4}', '\u{c5}',
    '\u{c9}', '\u{e6}', '\u{c6}', '\u{f4}', '\u{f6}', '\u{f2}', '\u{fb}', '\u{f9}',
    '\u{ff}', '\u{d6}', '\u{dc}', '\u{a2}', '\u{a3}', '\u{a5}', '\u{20a7}', '\u{192}',
    '\u{e1}', '\u{ed}', '\u{f3}', '\u{fa}', '\u{f1}', '\u{d1}', '\u{aa}', '\u{ba}',
    '\u{bf}', '\u{2310}', '\u{ac}', '\u{bd}', '\u{bc}', '\u{a1}', '\u{ab}', '\u{bb}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{2561}', '\u{2562}', '\u{2556}',
    '\u{2555}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255d}', '\u{255c}', '\u{255b}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252c}', '\u{251c}', '\u{2500}', '\u{253c}', '\u{255e}', '\u{255f}',
    '\u{255a}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256c}', '\u{2567}',
    '\u{2568}', '\u{2564}', '\u{2565}', '\u{2559}', '\u{2558}', '\u{2552}', '\u{2553}', '\u{256b}',
    '\u{256a}', '\u{2518}', '\u{250c}', '\u{2588}', '\u{2584}', '\u{258c}', '\u{2590}', '\u{2580}',
    '\u{3b1}', '\u{df}', '\u{393}', '\u{3c0}', '\u{3a3}', '\u{3c3}', '\u{b5}', '\u{3c4}',
    '\u{3a6}', '\u{398}', '\u{3a9}', '\u{3b4}', '\u{221e}', '\u{3c6}', '\u{3b5}', '\u{2229}',
    '\u{2261}', '\u{b1}', '\u{2265}', '\u{2264}', '\u{2320}', '\u{2321}', '\u{f7}', '\u{2248}',
    '\u{b0}', '\u{2219}', '\u{b7}', '\u{221a}', '\u{207f}', '\u{b2}', '\u{25a0}', '\u{a0}',
];

fn invalid(message: &str) -> Error {
    Error::new(ErrorKind::InvalidData, format!("archive-header-invalid: {message}"))
}

pub(crate) fn decode(raw: &[u8], utf8: bool) -> Result<Cow<'_, str>> {
    if utf8 || raw.is_ascii() {
        return std::str::from_utf8(raw).map(Cow::Borrowed)
            .map_err(|_| invalid("invalid ZIP UTF-8 name"));
    }
    // Unflagged bytes remain CP437 even when they also form valid UTF-8.
    Ok(Cow::Owned(raw.iter().map(|&byte| {
        if byte < 128 { char::from(byte) } else { CP437_HIGH[usize::from(byte - 128)] }
    }).collect()))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new(); crc.update(bytes); crc.sum()
}

fn invalid_comment(message: &str) -> Error {
    // Keep the historical native error surface for inert comment metadata.
    Error::new(ErrorKind::InvalidData, format!("invalid ZIP Unicode Comment {message}"))
}

pub(crate) fn validate_metadata(raw: &[u8], flags: u16, extra: &[u8], raw_comment: &[u8]) -> Result<()> {
    if flags & 0x800 != 0 { decode(raw, true)?; }
    let mut current_name = raw;
    // The native decoder has historically checked comment CRCs against its
    // decoded comment, including lossy flagged comments, rather than raw bytes.
    let mut comment = if flags & 0x800 != 0 { String::from_utf8_lossy(raw_comment) }
        else { decode(raw_comment, false)? };
    let mut offset = 0;
    while offset + 4 <= extra.len() {
        let id = u16::from_le_bytes([extra[offset], extra[offset + 1]]);
        let length = u16::from_le_bytes([extra[offset + 2], extra[offset + 3]]) as usize;
        offset += 4;
        // Leave unrelated extra-field framing to the ZIP decoder and physical admission.
        let Some(field) = extra.get(offset..offset + length) else { break; };
        if id == 0x7075 {
            if field.len() < 5 { return Err(invalid("truncated ZIP Unicode Path field")); }
            let checksum = crc32(current_name);
            if checksum != u32::from_le_bytes(field[1..5].try_into().unwrap()) {
                return Err(invalid("ZIP Unicode Path CRC mismatch"));
            }
            decode(&field[5..], true)?;
            // Advancing after each field both matches decoder order and bounds
            // total hashing by the original text plus the extra-field payloads.
            current_name = &field[5..];
        } else if id == 0x6375 {
            if field.len() < 5 { return Err(invalid_comment("field is truncated")); }
            if crc32(comment.as_bytes()) != u32::from_le_bytes(field[1..5].try_into().unwrap()) {
                return Err(invalid_comment("CRC mismatch"));
            }
            comment = Cow::Borrowed(std::str::from_utf8(&field[5..])
                .map_err(|_| invalid_comment("UTF-8"))?);
        }
        offset += length;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_utf8_shaped_bytes_are_cp437() {
        assert_eq!(decode("café".as_bytes(), false).unwrap(), "caf├⌐");
        assert_eq!(decode("café".as_bytes(), true).unwrap(), "café");
        assert_eq!(decode(&[b'c', b'a', b'f', 0x82], false).unwrap(), "café");
        assert!(decode(&[0xff], true).is_err());
    }
}
