use crate::{NativeResult, platform};

pub(crate) enum HashReader {
    Positioned(platform::IndependentReader),
    #[cfg(target_os = "windows")]
    OwnedPosition(windows::OwnedPositionReader),
}

impl HashReader {
    pub(crate) fn open(fd: i32, owns_position: bool) -> NativeResult<Self> {
        #[cfg(target_os = "windows")]
        if owns_position {
            return windows::OwnedPositionReader::open(fd).map(Self::OwnedPosition);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = owns_position;
        platform::open_independent_reader(fd).map(Self::Positioned)
    }

    pub(crate) fn read_at(&self, buffer: &mut [u8], offset: u64) -> NativeResult<usize> {
        match self {
            Self::Positioned(reader) => platform::read_at(reader, buffer, offset),
            #[cfg(target_os = "windows")]
            Self::OwnedPosition(reader) => reader.read_at(buffer, offset),
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::{mem::zeroed, ptr::null};
    use windows_sys::Win32::{
        Foundation::{ERROR_HANDLE_EOF, ERROR_IO_PENDING, GetLastError, HANDLE},
        Storage::FileSystem::ReadFile,
        System::{IO::{GetOverlappedResult, OVERLAPPED}, Threading::{CreateEventW, ResetEvent}},
    };
    use crate::{NativeResult, native_error, windows::{OwnedHandle, root_handle, win_error}};

    pub(crate) struct OwnedPositionReader {
        handle: HANDLE,
        event: OwnedHandle,
    }

    impl OwnedPositionReader {
        pub(crate) fn open(fd: i32) -> NativeResult<Self> {
            Self::from_handle(root_handle(fd)?)
        }

        fn from_handle(handle: HANDLE) -> NativeResult<Self> {
            // The pathname hasher alone owns this cursor until its worker joins.
            let event = unsafe { CreateEventW(null(), 1, 0, null()) };
            if event.is_null() {
                return Err(win_error(unsafe { GetLastError() }, "create hash read event"));
            }
            Ok(Self { handle, event: OwnedHandle(event) })
        }

        pub(crate) fn read_at(&self, buffer: &mut [u8], offset: u64) -> NativeResult<usize> {
            let length = u32::try_from(buffer.len())
                .map_err(|_| native_error("EINVAL", "hash buffer exceeds Windows range"))?;
            if offset > i64::MAX as u64 {
                return Err(native_error("EINVAL", "hash offset exceeds Windows range"));
            }
            if unsafe { ResetEvent(self.event.0) } == 0 {
                return Err(win_error(unsafe { GetLastError() }, "reset hash read event"));
            }
            let mut overlapped: OVERLAPPED = unsafe { zeroed() };
            overlapped.Anonymous.Anonymous.Offset = offset as u32;
            overlapped.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
            // Suppress completion-port packets referencing our stack OVERLAPPED.
            overlapped.hEvent = (self.event.0 as usize | 1) as HANDLE;
            let mut read = 0;
            // SAFETY: the caller retains the file; buffers, event and OVERLAPPED
            // stay alive until even an asynchronously opened handle completes.
            let completed = unsafe {
                ReadFile(self.handle, buffer.as_mut_ptr(), length, &mut read, &mut overlapped)
            };
            if completed == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_HANDLE_EOF { return Ok(0); }
                if error != ERROR_IO_PENDING { return Err(win_error(error, "read owned hash file")); }
                if unsafe { GetOverlappedResult(self.handle, &overlapped, &mut read, 1) } == 0 {
                    let error = unsafe { GetLastError() };
                    if error == ERROR_HANDLE_EOF { return Ok(0); }
                    return Err(win_error(error, "join owned hash read"));
                }
            }
            Ok(read as usize)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs::{self, OpenOptions}, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}};
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;

        #[test]
        fn owned_reads_join_sync_and_overlapped_handles_without_reopening() {
            for flags in [0, FILE_FLAG_OVERLAPPED] {
                let path = crate::test_support::temp_path("owned-hash-reader");
                let payload: Vec<u8> = (0..65_537).map(|i| (i % 251) as u8).collect();
                fs::write(&path, &payload).unwrap();
                let file = OpenOptions::new().read(true).custom_flags(flags).open(&path).unwrap();
                let reader = OwnedPositionReader::from_handle(file.as_raw_handle()).unwrap();
                assert_eq!(reader.handle, file.as_raw_handle());
                let mut buffer = vec![0; 65_536];
                assert_eq!(reader.read_at(&mut buffer, 0).unwrap(), buffer.len());
                assert_eq!(&buffer[..], &payload[..65_536]);
                assert_eq!(reader.read_at(&mut buffer, 65_536).unwrap(), 1);
                assert_eq!(buffer[0], payload[65_536]);
                assert_eq!(reader.read_at(&mut buffer, payload.len() as u64).unwrap(), 0);
                drop(reader);
                assert_eq!(file.metadata().unwrap().len(), payload.len() as u64);
                drop(file);
                fs::remove_file(path).unwrap();
            }
        }
    }
}
