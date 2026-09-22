use super::{MAX_SAFE_INTEGER, decimal};
use std::io;

fn assert_decimal(bytes: &[u8], expected: Option<u64>) {
    match (decimal(bytes), expected) {
        (Ok(actual), Some(expected)) => assert_eq!(actual, expected, "{bytes:?}"),
        (Err(error), None) => {
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{bytes:?}");
            assert_eq!(
                error.to_string(),
                "archive-header-invalid: unsupported or malformed PAX metadata",
                "{bytes:?}"
            );
        }
        (actual, expected) => panic!("{bytes:?}: expected {expected:?}, got {actual:?}"),
    }
}

#[test]
fn canonical_decimal_accepts_exact_safe_integer_boundaries() {
    for (bytes, expected) in [
        (b"0".as_slice(), 0),
        (b"1".as_slice(), 1),
        (b"10".as_slice(), 10),
        (b"999999999999999".as_slice(), 999_999_999_999_999),
        (b"1000000000000000".as_slice(), 1_000_000_000_000_000),
        (b"9007199254740990".as_slice(), MAX_SAFE_INTEGER - 1),
        (b"9007199254740991".as_slice(), MAX_SAFE_INTEGER),
    ] {
        assert_decimal(bytes, Some(expected));
    }
}

#[test]
fn canonical_decimal_rejections_keep_the_exact_metadata_error() {
    for bytes in [
        b"".as_slice(), b"00", b"01", b"00000000000000000", b"+0", b"+1", b"-0", b"-1",
        b" 1", b"1 ", b"\t1", b"1\n", b"1\0", b"1.0", b"1e3", b"0x10", b"1_000",
        b"9007199254740992", b"9999999999999999", b"10000000000000000", b"18446744073709551615",
        b"123456789012345x", b"1234567890123456x", b"\xff", b"1\xff", b"1\xc3", b"1\xc0\x80",
        "١".as_bytes(), "1١".as_bytes(), "１".as_bytes(),
    ] {
        assert_decimal(bytes, None);
    }
    assert_decimal(&vec![b'1'; 65_536], None);
}

#[test]
fn every_one_and_two_byte_value_obeys_canonical_ascii_decimal() {
    for first in 0_u8..=u8::MAX {
        assert_decimal(&[first], first.is_ascii_digit().then(|| u64::from(first - b'0')));
        for second in 0_u8..=u8::MAX {
            let expected = if (b'1'..=b'9').contains(&first) && second.is_ascii_digit() {
                Some(u64::from(first - b'0') * 10 + u64::from(second - b'0'))
            } else {
                None
            };
            assert_decimal(&[first, second], expected);
        }
    }
}
