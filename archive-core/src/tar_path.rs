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
        if !prefix.is_empty() {
            validate_path(prefix, windows)?;
            // A separator preserves both independently validated component lists.
            return Ok(format!("{prefix}/{name}"));
        }
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{INVALID_PATH, validate_member, validate_path};

    fn ustar_header(name: &[u8], prefix: &[u8]) -> [u8; 512] {
        assert!(name.len() <= 100 && prefix.len() <= 155);
        let mut header = [0; 512];
        header[..name.len()].copy_from_slice(name);
        header[257..265].copy_from_slice(b"ustar\x0000");
        header[345..345 + prefix.len()].copy_from_slice(prefix);
        header
    }

    #[test]
    fn admitted_ustar_components_preserve_literal_joined_identity() {
        for (prefix, name) in [
            ("".to_owned(), "leaf".to_owned()),
            ("pkg".to_owned(), "leaf".to_owned()),
            ("pkg/".to_owned(), "./leaf".to_owned()),
            ("pkg\\".to_owned(), ".\\leaf".to_owned()),
            ("./pkg//.".to_owned(), "./leaf".to_owned()),
            (".".to_owned(), ".".to_owned()),
            ("nested/cafe\u{301}".to_owned(), "caf\u{e9}".to_owned()),
            ("각".repeat(28), "각".repeat(28)),
            ("p".repeat(155), "n".repeat(100)),
        ] {
            let expected = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            for windows in [false, true] {
                let header = ustar_header(name.as_bytes(), prefix.as_bytes());
                assert_eq!(validate_member(&header, windows).unwrap(), expected);
                validate_path(&expected, windows).unwrap();
            }
        }
    }

    #[test]
    fn ustar_fields_retain_individual_syntax_and_normalization_rejections() {
        for (prefix, name, windows_only) in [
            ("pkg".to_owned(), "/absolute".to_owned(), false),
            ("pkg".to_owned(), "\\absolute".to_owned(), false),
            ("/absolute".to_owned(), "leaf".to_owned(), false),
            ("pkg".to_owned(), "C:drive".to_owned(), false),
            ("C:drive".to_owned(), "leaf".to_owned(), false),
            ("pkg".to_owned(), "../leaf".to_owned(), false),
            ("pkg\\..\\bad".to_owned(), "leaf".to_owned(), false),
            ("각".repeat(29), "leaf".to_owned(), false),
            ("pkg".to_owned(), "각".repeat(29), false),
            ("C".to_owned(), ":leaf".to_owned(), true),
            ("pkg".to_owned(), "leaf:stream".to_owned(), true),
            ("pkg:stream".to_owned(), "leaf".to_owned(), true),
        ] {
            for windows in [false, true] {
                let result = validate_member(&ustar_header(name.as_bytes(), prefix.as_bytes()), windows);
                if windows_only && !windows {
                    assert_eq!(result.unwrap(), format!("{prefix}/{name}"));
                } else {
                    assert_eq!(result.unwrap_err().to_string(), INVALID_PATH, "prefix={prefix:?}, name={name:?}");
                }
            }
        }
    }

    #[test]
    fn ustar_fields_still_reject_hidden_nul_suffixes_and_invalid_utf8() {
        let cases: &[(&[u8], &[u8])] = &[
            (b"pkg", b"safe\0hidden"), (b"safe\0hidden", b"leaf"),
            (b"pkg", &[0xff]), (&[0xff], b"leaf"),
        ];
        for (prefix, name) in cases {
            for windows in [false, true] {
                let error = validate_member(&ustar_header(name, prefix), windows).unwrap_err();
                assert_eq!(error.to_string(), INVALID_PATH);
            }
        }
    }

    #[test]
    fn empty_ustar_prefixes_still_decode_the_selected_field() {
        let mut header = ustar_header(b"leaf", b"");
        header[476..488].copy_from_slice(b"00000000001\0");
        header[488..500].copy_from_slice(b"00000000002\0");
        for windows in [false, true] {
            // With byte 475 zero, valid star timestamps are outside the prefix.
            assert_eq!(validate_member(&header, windows).unwrap(), "leaf");
            for offset in [346, 474, 475] {
                let mut hidden = header;
                hidden[offset] = b'x';
                let error = validate_member(&hidden, windows).unwrap_err();
                assert_eq!(error.to_string(), INVALID_PATH, "hidden prefix byte {offset}");
            }
        }
    }

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
