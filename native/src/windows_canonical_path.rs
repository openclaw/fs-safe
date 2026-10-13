//! One owner of normalized Windows names. A translated name never supplies identity.
use crate::{NativeResult, native_error};

fn unavailable() -> crate::NativeError {
    native_error(
        "path-mismatch",
        "Windows canonical path cannot be verified safely",
    )
}

fn drive_root(input: &str) -> Option<String> {
    let path = input.strip_prefix(r"\\?\").unwrap_or(input);
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\")
        .then(|| path[..3].to_owned())
}

fn translate_nt_path(
    input: &str,
    nt_path: &str,
    drive_nt: Option<&str>,
    equal: impl Fn(&[u16], &[u16]) -> bool,
) -> NativeResult<String> {
    let input = input.replace('/', "\\");
    let root = drive_root(&input);
    let input_unc = input.starts_with(r"\\")
        && !input.starts_with(r"\\.\")
        && (!input.starts_with(r"\\?\") || input.starts_with(r"\\?\UNC\"));
    let nt: Vec<u16> = nt_path.encode_utf16().collect();
    let mup: Vec<u16> = r"\Device\Mup\".encode_utf16().collect();
    if (root.is_some() || input_unc) && nt.len() > mup.len() && equal(&nt[..mup.len()], &mup) {
        let tail = String::from_utf16(&nt[mup.len()..]).map_err(|_| unavailable())?;
        let mut parts = tail.split('\\');
        if parts.next().is_none_or(str::is_empty) || parts.next().is_none_or(str::is_empty) {
            return Err(unavailable());
        }
        return Ok(format!(r"\\{tail}"));
    }
    let root = root.ok_or_else(unavailable)?;
    let prefix: Vec<u16> = drive_nt
        .ok_or_else(unavailable)?
        .trim_end_matches('\\')
        .encode_utf16()
        .collect();
    if prefix.is_empty()
        || nt.len() < prefix.len()
        || !equal(&nt[..prefix.len()], &prefix)
        || (nt.len() > prefix.len() && nt[prefix.len()] != b'\\' as u16)
    {
        return Err(unavailable());
    }
    let suffix = String::from_utf16(&nt[prefix.len()..]).map_err(|_| unavailable())?;
    Ok(format!("{root}{}", suffix.trim_start_matches('\\')))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::windows::{open_existing_handle, wide_absolute_path, win_error};
    use windows_sys::Win32::{
        Foundation::{ERROR_ACCESS_DENIED, GetLastError, HANDLE},
        Globalization::{CSTR_EQUAL, CompareStringOrdinal},
        Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, GetFinalPathNameByHandleW, VOLUME_NAME_NT,
        },
    };

    pub(crate) const INITIAL_PATH_WCHARS: usize = 512;

    fn absolute_input(input: &str) -> NativeResult<String> {
        let path = std::path::absolute(input).map_err(|_| unavailable())?;
        Ok(path.to_str().ok_or_else(unavailable)?.replace('/', "\\"))
    }

    fn unavailable_query() -> crate::NativeError {
        native_error(
            "OBSERVATION_UNAVAILABLE",
            "observed directory path changed or could not be resolved",
        )
    }

    pub(crate) fn canonical_path_with_query(
        handle: HANDLE,
        mut query: impl FnMut(HANDLE, &mut [u16]) -> NativeResult<usize>,
    ) -> NativeResult<String> {
        let mut stack = [0_u16; INITIAL_PATH_WCHARS];
        let written = query(handle, &mut stack)?;
        let mut heap = Vec::new();
        let encoded = if written > 0 && written < stack.len() {
            &stack[..written]
        } else if written >= stack.len() {
            let capacity = written
                .checked_add(1)
                .filter(|n| *n <= 32768)
                .ok_or_else(unavailable_query)?;
            heap.try_reserve_exact(capacity)
                .map_err(|_| unavailable_query())?;
            heap.resize(capacity, 0);
            let confirmed = query(handle, &mut heap)?;
            if confirmed == 0 || confirmed >= heap.len() {
                return Err(unavailable_query());
            }
            &heap[..confirmed]
        } else {
            return Err(unavailable_query());
        };
        let path = String::from_utf16(encoded).map_err(|_| unavailable_query())?;
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        Ok(path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned())
    }

    fn query_name(handle: HANDLE, flags: u32) -> NativeResult<String> {
        canonical_path_with_query(handle, |handle, buffer| {
            // Normalized names only: FILE_NAME_OPENED does not prove physical spelling.
            let written = unsafe {
                GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, flags)
            };
            if written == 0 {
                return Err(win_error(
                    unsafe { GetLastError() },
                    "resolve canonical path",
                ));
            }
            Ok(written as usize)
        })
    }

    fn equal_ordinal(left: &[u16], right: &[u16]) -> bool {
        left.len() == right.len()
            && unsafe {
                CompareStringOrdinal(
                    left.as_ptr(),
                    left.len() as i32,
                    right.as_ptr(),
                    right.len() as i32,
                    1,
                ) == CSTR_EQUAL
            }
    }

    enum Resolution {
        Path(String),
        Translated(String),
        OriginalError(crate::NativeError),
    }

    fn resolve_handle(handle: HANDLE, input: &str) -> NativeResult<Resolution> {
        let denied = match query_name(handle, 0) {
            Ok(path) => {
                return Ok(Resolution::Path(path));
            }
            Err(error) if error.errno == Some(ERROR_ACCESS_DENIED) => error,
            Err(error) => return Ok(Resolution::OriginalError(error)),
        };
        if !crate::windows_appcontainer::is_app_container()? {
            return Ok(Resolution::OriginalError(denied));
        }
        // The denied DOS query and successful NT query share the exact same handle.
        let nt = match query_name(handle, VOLUME_NAME_NT) {
            Ok(path) => path,
            // A disappearing file is still the original denial, not a translation error.
            Err(_) => return Ok(Resolution::OriginalError(denied)),
        };
        let input = absolute_input(input)?;
        if nt
            .get(..12)
            .is_some_and(|s| s.eq_ignore_ascii_case(r"\Device\Mup\"))
        {
            return translate_nt_path(&input, &nt, None, equal_ordinal).map(Resolution::Translated);
        }
        let root = drive_root(&input).ok_or_else(unavailable)?;
        // No cache: drive mappings and volume mount points can change in a live process.
        let root_handle = open_existing_handle(
            &wide_absolute_path(&root),
            0,
            FILE_FLAG_BACKUP_SEMANTICS,
            |code| win_error(code, "open canonicalization drive root"),
        )?;
        let prefix = query_name(root_handle.0, VOLUME_NAME_NT)?;
        translate_nt_path(&input, &nt, Some(&prefix), equal_ordinal).map(Resolution::Translated)
    }

    pub(crate) fn canonical_path(handle: HANDLE, input: &str) -> NativeResult<String> {
        match resolve_handle(handle, input)? {
            Resolution::Path(path) | Resolution::Translated(path) => Ok(path),
            Resolution::OriginalError(error) => Err(error),
        }
    }

    #[cfg(test)]
    mod query_tests {
        include!("directory_observation_windows_tests.rs");

        #[test]
        fn resolves_relative_inputs_against_the_process_directory() {
            let cwd = std::env::current_dir().unwrap();
            let expected = cwd.join("secret").to_str().unwrap().replace('/', "\\");
            for input in ["secret", "./secret", r"child\..\secret", "child/../secret"] {
                assert_eq!(absolute_input(input).unwrap(), expected);
            }
            assert!(std::path::Path::new(&absolute_input("secret").unwrap()).is_absolute());
        }
    }

    #[napi_derive::napi(js_name = "resolveWindowsCanonicalPath")]
    pub fn resolve_windows_canonical_path(env: napi::Env, path: String) -> napi::Result<Option<String>> {
        crate::into_napi(
            env,
            (|| {
                if path.contains('\0') {
                    return Err(unavailable());
                }
                if !crate::windows_appcontainer::is_app_container()? {
                    return Ok(None);
                }
                let path = absolute_input(&path)?;
                let handle = match open_existing_handle(
                    &wide_absolute_path(&path),
                    0,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    |code| win_error(code, "open canonicalization path"),
                ) {
                    Ok(handle) => handle,
                    Err(_) => return Ok(None),
                };
                match resolve_handle(handle.0, &path)? {
                    Resolution::Translated(path) => Ok(Some(path)),
                    Resolution::Path(_) | Resolution::OriginalError(_) => Ok(None),
                }
            })(),
        )
    }
}

#[cfg(windows)]
pub(crate) use platform::canonical_path;

#[cfg(test)]
mod tests {
    use super::*;
    fn translate(input: &str, nt: &str, prefix: Option<&str>) -> NativeResult<String> {
        translate_nt_path(input, nt, prefix, |a, b| {
            String::from_utf16(a)
                .unwrap()
                .eq_ignore_ascii_case(&String::from_utf16(b).unwrap())
        })
    }
    #[test]
    fn translates_unc_and_drive_names() {
        assert_eq!(
            translate(r"\\server\share\x", r"\Device\Mup\server\share\x", None).unwrap(),
            r"\\server\share\x"
        );
        assert_eq!(
            translate(
                r"C:\SHORT~1",
                r"\Device\HarddiskVolume4\Long name",
                Some(r"\device\harddiskvolume4\")
            )
            .unwrap(),
            r"C:\Long name"
        );
        assert_eq!(
            translate(
                r"\\?\C:\",
                r"\Device\HarddiskVolume4",
                Some(r"\Device\HarddiskVolume4\")
            )
            .unwrap(),
            "C:\\"
        );
    }
    #[test]
    fn classifies_unc_using_the_normalized_open_spelling() {
        for input in [
            "//server/share/x",
            r"\\server/share\x",
            r"\\?\UNC/server/share/x",
        ] {
            assert_eq!(
                translate(input, r"\Device\Mup\server\share\x", None).unwrap(),
                r"\\server\share\x"
            );
        }
        for input in ["//./server/share/x", "//?/Volume{abc}/x"] {
            assert!(translate(input, r"\Device\Mup\server\share\x", None).is_err());
        }
    }
    #[test]
    fn rejects_mismatched_prefixes_and_mounted_folders() {
        for nt in [r"\Device\HarddiskVolume40\x", r"\Device\HarddiskVolume5\x"] {
            assert_eq!(
                translate(r"C:\mount\x", nt, Some(r"\Device\HarddiskVolume4\"))
                    .unwrap_err()
                    .status,
                "path-mismatch"
            );
        }
        for input in [r"relative\x", r"\\?\Volume{abc}\x", r"\rooted\x"] {
            assert!(
                translate(
                    input,
                    r"\Device\HarddiskVolume4\x",
                    Some(r"\Device\HarddiskVolume4\")
                )
                .is_err()
            );
        }
        assert!(translate(r"\\server\share", r"\Device\Mup\server", None).is_err());
    }
}
