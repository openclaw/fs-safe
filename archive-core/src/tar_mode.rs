use crate::tar_meter::MAX_SAFE_INTEGER;

/// Normalize absent and supported GNU modes without changing the native manifest ABI.
pub(crate) fn manifest_mode(header: &[u8; 512], directory: bool) -> u32 {
    let field: &[u8; 8] = header[100..108].try_into().unwrap();
    if field.iter().all(|byte| matches!(*byte, 0 | b' ')) {
        return if directory { 0o755 } else { 0o644 };
    }
    let value = match field[0] {
        0x80 => {
            let mut bytes = *field;
            bytes[0] = 0;
            Some(i64::from_be_bytes(bytes))
        }
        0xff => Some(i64::from_be_bytes(*field)),
        _ => None,
    };
    if let Some(value) = value
        && (-(MAX_SAFE_INTEGER as i64)..=MAX_SAFE_INTEGER as i64).contains(&value)
    {
        // node-tar's ReadEntry masks safe signed numbers to rwx + special bits.
        // Do not narrow to u32 before checking its JavaScript numeric domain.
        return (value & 0o7777) as u32;
    }
    // Malformed or unsupported fields have one common zero fallback.
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    let text = std::str::from_utf8(&field[..end]).unwrap_or("").trim_matches(' ');
    if text.is_empty() || !text.bytes().all(|b| (b'0'..=b'7').contains(&b)) { return 0; }
    u32::from_str_radix(text, 8).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(field: [u8; 8], directory: bool) -> u32 {
        let mut header = tar::Header::new_ustar();
        header.as_old_mut().mode = field;
        manifest_mode(header.as_bytes(), directory)
    }

    #[test]
    fn blank_padding_is_absent_but_octal_zero_is_explicit() {
        for directory in [false, true] {
            for field in [[0; 8], [b' '; 8], [b' ', 0, b' ', 0, 0, 0, 0, 0]] {
                assert_eq!(mode(field, directory), if directory { 0o755 } else { 0o644 });
            }
            assert_eq!(mode(*b"0000000\0", directory), 0);
        }
    }

    #[test]
    fn supported_binary_domain_retains_permission_bits() {
        for (value, expected) in [
            (0, 0), (0o755, 0o755), ((1_i64 << 32) + 0o755, 0o755),
            (MAX_SAFE_INTEGER as i64, 0o7777), (-1, 0o7777),
            (-256, 0o7400), (-512, 0o7000), (-(MAX_SAFE_INTEGER as i64), 1),
        ] {
            let mut field = value.to_be_bytes();
            if value >= 0 { field[0] = 0x80; }
            assert_eq!(mode(field, false), expected, "value={value}");
        }
    }

    #[test]
    fn malformed_and_unsupported_modes_keep_the_existing_zero_fallback() {
        for field in [
            *b"invalid!", *b"0000755x", *b"-0000400", *b"\0invalid",
            [0x81, 0, 0, 0, 0, 0, 1, 0xff],
            [0x80, 0x20, 0, 0, 0, 0, 0, 1], // Above Number.MAX_SAFE_INTEGER.
            [0xff, 0xdf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        ] {
            assert_eq!(mode(field, false), 0, "field={field:?}");
            assert_eq!(mode(field, true), 0, "field={field:?}");
        }
    }
}
