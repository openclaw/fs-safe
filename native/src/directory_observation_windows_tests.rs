use super::*;
use windows_sys::Win32::Foundation::HANDLE;

fn queried_name(path: &str, buffer: &mut [u16]) -> usize {
    let encoded: Vec<u16> = path.encode_utf16().collect();
    if encoded.len() >= buffer.len() {
        return encoded.len() + 1;
    }
    buffer[..encoded.len()].copy_from_slice(&encoded);
    buffer[encoded.len()] = 0;
    encoded.len()
}

#[test]
fn normalized_short_names_use_one_query_on_the_same_handle() {
    for (returned, expected) in [
        (r"\\?\C:\root\directory", r"C:\root\directory"),
        (r"\\?\UNC\server\share\directory", r"\\server\share\directory"),
    ] {
        let handle = 0x1234_usize as HANDLE;
        let mut calls = 0;
        let observed = canonical_path_with_query(handle, |current, buffer| {
            calls += 1;
            assert_eq!(current, handle);
            assert_eq!(buffer.len(), INITIAL_PATH_WCHARS);
            Ok(queried_name(returned, buffer))
        }).unwrap();
        assert_eq!(observed, expected);
        assert_eq!(calls, 1);
    }
}

#[test]
fn long_names_receive_one_bounded_resize_on_the_same_handle() {
    let returned = format!(r"\\?\C:\{}", "a".repeat(INITIAL_PATH_WCHARS + 80));
    let handle = 0x1234_usize as HANDLE;
    let mut calls = 0;
    let observed = canonical_path_with_query(handle, |current, buffer| {
        calls += 1;
        assert_eq!(current, handle);
        if calls == 1 {
            assert_eq!(buffer.len(), INITIAL_PATH_WCHARS);
        } else {
            assert_eq!(buffer.len(), returned.encode_utf16().count() + 2);
        }
        Ok(queried_name(&returned, buffer))
    }).unwrap();
    assert_eq!(observed, returned.strip_prefix(r"\\?\").unwrap());
    assert_eq!(calls, 2);
}

#[test]
fn a_name_growing_past_the_retry_buffer_is_not_truncated() {
    let mut calls = 0;
    let error = canonical_path_with_query(0x1234_usize as HANDLE, |_handle, buffer| {
        calls += 1;
        Ok(buffer.len() + 100)
    }).unwrap_err();
    assert_eq!(error.status, "OBSERVATION_UNAVAILABLE");
    assert_eq!(calls, 2);
}

#[test]
fn zero_and_malformed_utf16_are_not_accepted_as_paths() {
    let handle = 0x1234_usize as HANDLE;
    assert_eq!(canonical_path_with_query(handle, |_, _| Ok(0)).unwrap_err().status,
        "OBSERVATION_UNAVAILABLE");
    assert_eq!(canonical_path_with_query(handle, |_, buffer| {
        buffer[0] = 0xd800;
        Ok(1)
    }).unwrap_err().status, "OBSERVATION_UNAVAILABLE");
}

#[test]
fn query_failures_stay_fail_closed() {
    let mut calls = 0;
    let error = canonical_path_with_query(0x1234_usize as HANDLE, |_, _| {
        calls += 1;
        Err(native_error("OBSERVATION_UNAVAILABLE", "injected query failure"))
    }).unwrap_err();
    assert_eq!(error.status, "OBSERVATION_UNAVAILABLE");
    assert_eq!(calls, 1);
}
