use std::io;
use unicode_normalization::UnicodeNormalization;

pub const INVALID_PATH: &str = "archive-entry-path-invalid";

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, INVALID_PATH)
}

pub fn validate_path(name: &str, windows: bool) -> io::Result<()> {
    if name.contains('\0') || name.starts_with(['/', '\\'])
        || name.split(['/', '\\']).any(|part| part == "..") {
        return Err(invalid());
    }
    if name.split(['/', '\\']).any(|part| {
        let bytes = part.as_bytes();
        (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
            || (windows && part.contains(':'))
            || if part.is_ascii() {
                // NFC/NFD cannot change ASCII; avoid Unicode iteration on long metadata paths.
                bytes.len() > 255
            } else {
                part.nfc().map(char::len_utf8).sum::<usize>() > 255
                    || part.nfd().map(char::len_utf8).sum::<usize>() > 255
            }
    }) {
        return Err(invalid());
    }
    Ok(())
}

fn path_field(field: &[u8]) -> io::Result<&str> {
    let end = field.iter().position(|byte| *byte == 0).unwrap_or(field.len());
    if field[end..].iter().any(|byte| *byte != 0) {
        return Err(invalid());
    }
    std::str::from_utf8(&field[..end]).map_err(|_| invalid())
}

pub fn validate_header_fields(header: &[u8; 512]) -> io::Result<()> {
    path_field(&header[..100])?;
    let linkname = path_field(&header[157..257])?;
    if &header[257..265] == b"ustar\x0000" {
        path_field(&header[345..if header[475] == 0 { 475 } else { 500 }])?;
    }
    let is_link = matches!(header[156], b'1' | b'2');
    if is_link && linkname.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData,
            "archive-header-invalid: linkname required on a link header"));
    }
    if !is_link && !linkname.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData,
            "archive-header-invalid: linkname forbidden on a non-link header"));
    }
    Ok(())
}

// Validate original components even when PAX/GNU replaces the member name.
// Both executors consume this decoded identity.
pub fn validate_member(header: &[u8; 512], windows: bool) -> io::Result<String> {
    let name = path_field(&header[..100])?;
    validate_path(name, windows)?;
    if &header[257..265] == b"ustar\x0000" {
        // Match node-tar's star layout; atime/ctime are not prefix bytes.
        let prefix_end = if header[475] == 0 { 475 } else { 500 };
        let prefix = path_field(&header[345..prefix_end])?;
        validate_path(prefix, windows)?;
        if !prefix.is_empty() {
            let path = format!("{prefix}/{name}");
            validate_path(&path, windows)?;
            return Ok(path);
        }
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::validate_path;

    #[test]
    fn component_limits_preserve_ascii_and_unicode_normalization_boundaries() {
        for windows in [false, true] {
            for (name, accepted) in [
                ("a".repeat(255), true),
                ("a".repeat(256), false),
                (format!("{}\n", "a".repeat(254)), true),
                ("é".repeat(85), true),
                ("é".repeat(86), false),
                ("각".repeat(28), true),
                ("각".repeat(29), false),
            ] {
                assert_eq!(validate_path(&name, windows).is_ok(), accepted);
            }
            for name in ["../leaf", "pkg/C:leaf", "/absolute", "nul\0name"] {
                assert!(validate_path(name, windows).is_err());
            }
            assert_eq!(validate_path("name:stream", windows).is_ok(), !windows);
        }
    }
}
