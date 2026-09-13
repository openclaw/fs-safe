use std::ffi::c_void;
use std::mem::{size_of, size_of_val};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_HANDLE_EOF, ERROR_MORE_DATA, GetLastError, HANDLE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_END_OF_FILE_INFO, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_STREAM_INFO, FileBasicInfo,
    FileEndOfFileInfo, FileStreamInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    GetVolumeInformationByHandleW, SetFileInformationByHandle,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::{
    DUPLICATE_EXTENTS_DATA, FSCTL_DUPLICATE_EXTENTS_TO_FILE, FSCTL_GET_INTEGRITY_INFORMATION,
    FSCTL_GET_INTEGRITY_INFORMATION_BUFFER, FSCTL_GET_REPARSE_POINT,
    FSCTL_SET_INTEGRITY_INFORMATION, FSCTL_SET_INTEGRITY_INFORMATION_BUFFER,
    FSCTL_SET_REPARSE_POINT, FSCTL_SET_SPARSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::windows::{
    OwnedHandle, ReparsePolicy, handle_identity, handle_is_reparse, list_directory_entries,
    mark_handle_for_deletion, nt_open_relative_with_policy, nt_open_relative_with_sharing,
    remove_directory_handle, root_handle, win_error,
};
use crate::{NativeResult, native_error};

const DELETE_ACCESS: u32 = 0x0001_0000;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const FILE_DIRECTORY_FILE: u32 = 1;
const FILE_NO_INTERMEDIATE_BUFFERING: u32 = 8;
const FILE_SUPPORTS_BLOCK_REFCOUNTING: u32 = 0x0800_0000;
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xa000_0003;
const IO_REPARSE_TAG_SYMLINK: u32 = 0xa000_000c;

// Windows permits concurrent handle-relative opens. Each directory is enumerated by
// exactly one producer; workers only use these handles as pinned parent capabilities.
struct Directory(OwnedHandle);
unsafe impl Send for Directory {}
unsafe impl Sync for Directory {}

struct FileJob {
    source_parent: Arc<Directory>,
    target_parent: Arc<Directory>,
    name: String,
    attributes: u32,
    file_id: u64,
    volume: u32,
}

fn check_cancelled(cancelled: &AtomicBool) -> NativeResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(native_error("ABORT_ERR", "directory clone was cancelled"))
    } else {
        Ok(())
    }
}

fn validate_basename(name: &str) -> NativeResult<()> {
    crate::validate_relative_path(name, false)?;
    if name.contains(['/', '\\', ':']) {
        return Err(native_error("EINVAL", "clone requires a direct child name"));
    }
    Ok(())
}

fn is_refs(handle: HANDLE) -> NativeResult<bool> {
    let mut filesystem = [0_u16; 32];
    let mut flags = 0;
    if unsafe {
        GetVolumeInformationByHandleW(
            handle,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(win_error(unsafe { GetLastError() }, "inspect clone volume"));
    }
    let end = filesystem
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(filesystem.len());
    Ok(
        String::from_utf16_lossy(&filesystem[..end]).eq_ignore_ascii_case("ReFS")
            && flags & FILE_SUPPORTS_BLOCK_REFCOUNTING != 0,
    )
}

pub(crate) fn probe(parent_fd: i32) -> NativeResult<Option<String>> {
    Ok(is_refs(root_handle(parent_fd)?)?.then(|| "refs".to_owned()))
}

fn create_directory(parent: HANDLE, name: &str) -> NativeResult<Arc<Directory>> {
    validate_basename(name)?;
    let directory = nt_open_relative_with_policy(
        parent,
        name,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS,
        FILE_CREATE,
        FILE_DIRECTORY_FILE,
        ReparsePolicy::Reject,
    )?;
    Ok(Arc::new(Directory(directory)))
}

pub(crate) fn create_source(parent_fd: i32, basename: &str) -> NativeResult<()> {
    let parent = root_handle(parent_fd)?;
    if !is_refs(parent)? {
        return Err(native_error("ENOTSUP", "directory cloning requires ReFS"));
    }
    create_directory(parent, basename)?;
    Ok(())
}

fn file_information(handle: HANDLE) -> NativeResult<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(win_error(unsafe { GetLastError() }, "inspect clone source"));
    }
    Ok(info)
}

fn metadata(handle: HANDLE) -> NativeResult<FILE_BASIC_INFO> {
    let mut info = FILE_BASIC_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(win_error(unsafe { GetLastError() }, "read clone metadata"));
    }
    Ok(info)
}

fn reject_named_streams(handle: HANDLE) -> NativeResult<()> {
    // The unnamed stream fits easily; a larger response necessarily contains a
    // named stream. Refuse it instead of silently discarding application data.
    let mut storage = [0_u64; 64];
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStreamInfo,
            storage.as_mut_ptr().cast(),
            size_of_val(&storage) as u32,
        )
    } == 0
    {
        let error = unsafe { GetLastError() };
        if error == ERROR_HANDLE_EOF {
            return Ok(());
        }
        if error == ERROR_MORE_DATA {
            return Err(native_error(
                "ENOTSUP",
                "clone does not support named data streams",
            ));
        }
        return Err(win_error(error, "inspect clone data streams"));
    }
    let info = unsafe { &*storage.as_ptr().cast::<FILE_STREAM_INFO>() };
    if info.StreamNameLength == 0 && info.NextEntryOffset == 0 {
        return Ok(());
    }
    let name = [
        b':' as u16,
        b':' as u16,
        b'$' as u16,
        b'D' as u16,
        b'A' as u16,
        b'T' as u16,
        b'A' as u16,
    ];
    let name_offset = std::mem::offset_of!(FILE_STREAM_INFO, StreamName);
    if info.NextEntryOffset != 0 || info.StreamNameLength as usize != name.len() * 2 {
        return Err(native_error(
            "ENOTSUP",
            "clone does not support named data streams",
        ));
    }
    let actual = unsafe {
        std::slice::from_raw_parts(
            storage.as_ptr().cast::<u8>().add(name_offset).cast::<u16>(),
            name.len(),
        )
    };
    if actual != name {
        return Err(native_error(
            "ENOTSUP",
            "clone does not support named data streams",
        ));
    }
    Ok(())
}

fn set_metadata(handle: HANDLE, mut info: FILE_BASIC_INFO) -> NativeResult<()> {
    // Sparse, integrity and reparse attributes belong to their respective FSCTLs.
    info.FileAttributes &= 0x3127;
    if info.FileAttributes == 0 {
        info.FileAttributes = FILE_ATTRIBUTE_NORMAL;
    }
    info.ChangeTime = 0;
    if unsafe {
        SetFileInformationByHandle(
            handle,
            FileBasicInfo,
            (&info as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(win_error(
            unsafe { GetLastError() },
            "preserve clone metadata",
        ));
    }
    Ok(())
}

fn control(
    handle: HANDLE,
    code: u32,
    input: *const c_void,
    input_size: u32,
    output: *mut c_void,
    output_size: u32,
) -> NativeResult<u32> {
    let mut returned = 0;
    // All callers pass initialized buffers whose lifetimes cover this synchronous call.
    if unsafe {
        DeviceIoControl(
            handle,
            code,
            input,
            input_size,
            output,
            output_size,
            &mut returned,
            null_mut(),
        )
    } == 0
    {
        return Err(win_error(
            unsafe { GetLastError() },
            &format!("clone control {code:#x}"),
        ));
    }
    Ok(returned)
}

fn open_source(job: &FileJob) -> NativeResult<(OwnedHandle, BY_HANDLE_FILE_INFORMATION)> {
    let is_reparse = job.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let is_directory = job.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    // Denying write sharing rejects existing writers and excludes new writers
    // until the extent clone settles; timestamps alone cannot establish stability.
    let source = nt_open_relative_with_sharing(
        job.source_parent.0.0,
        &job.name,
        FILE_GENERIC_READ,
        FILE_OPEN,
        if !is_reparse && !is_directory {
            FILE_NO_INTERMEDIATE_BUFFERING
        } else {
            0
        },
        ReparsePolicy::AllowLeaf,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
    )?;
    let information = file_information(source.0)?;
    let identity = (
        information.dwVolumeSerialNumber,
        ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
        information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
    );
    if identity != (job.volume, job.file_id, is_directory)
        || (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0) != is_reparse
    {
        return Err(native_error(
            "path-mismatch",
            "clone source changed while opening",
        ));
    }
    Ok((source, information))
}

fn clone_reparse(source: HANDLE, target: HANDLE) -> NativeResult<()> {
    let mut data = [0_u8; 16 * 1024];
    let count = control(
        source,
        FSCTL_GET_REPARSE_POINT,
        null(),
        0,
        data.as_mut_ptr().cast(),
        data.len() as u32,
    )?;
    if count < 8 || count as usize > data.len() {
        return Err(native_error("EIO", "invalid clone reparse data"));
    }
    let tag = u32::from_le_bytes(data[..4].try_into().unwrap());
    if !matches!(tag, IO_REPARSE_TAG_SYMLINK | IO_REPARSE_TAG_MOUNT_POINT) {
        return Err(native_error(
            "ENOTSUP",
            "clone supports only symlink and junction reparse points",
        ));
    }
    control(
        target,
        FSCTL_SET_REPARSE_POINT,
        data.as_ptr().cast(),
        count,
        null_mut(),
        0,
    )?;
    Ok(())
}

fn clone_file(job: FileJob, cancelled: &AtomicBool) -> NativeResult<()> {
    check_cancelled(cancelled)?;
    let (source, information) = open_source(&job)?;
    reject_named_streams(source.0)?;
    let before = metadata(source.0)?;
    let reparse = information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let target = nt_open_relative_with_policy(
        job.target_parent.0.0,
        &job.name,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS,
        FILE_CREATE,
        if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            FILE_DIRECTORY_FILE
        } else {
            0
        },
        ReparsePolicy::Reject,
    )?;
    if reparse {
        clone_reparse(source.0, target.0)?;
    } else {
        let mut integrity = FSCTL_GET_INTEGRITY_INFORMATION_BUFFER::default();
        control(
            source.0,
            FSCTL_GET_INTEGRITY_INFORMATION,
            null(),
            0,
            (&mut integrity as *mut FSCTL_GET_INTEGRITY_INFORMATION_BUFFER).cast(),
            size_of::<FSCTL_GET_INTEGRITY_INFORMATION_BUFFER>() as u32,
        )?;
        let settings = FSCTL_SET_INTEGRITY_INFORMATION_BUFFER {
            ChecksumAlgorithm: integrity.ChecksumAlgorithm,
            Reserved: 0,
            Flags: integrity.Flags,
        };
        control(
            target.0,
            FSCTL_SET_INTEGRITY_INFORMATION,
            (&settings as *const FSCTL_SET_INTEGRITY_INFORMATION_BUFFER).cast(),
            size_of::<FSCTL_SET_INTEGRITY_INFORMATION_BUFFER>() as u32,
            null_mut(),
            0,
        )?;
        control(target.0, FSCTL_SET_SPARSE, null(), 0, null_mut(), 0)?;
        let size = ((information.nFileSizeHigh as u64) << 32) | information.nFileSizeLow as u64;
        let cluster = u64::from(integrity.ClusterSizeInBytes);
        if !cluster.is_power_of_two() || cluster > 0x8000_0000 {
            return Err(native_error("EIO", "invalid ReFS clone cluster size"));
        }
        let rounded = size
            .checked_add(cluster - 1)
            .map(|value| value / cluster * cluster)
            .filter(|value| *value <= i64::MAX as u64)
            .ok_or_else(|| native_error("EFBIG", "clone size exceeds Windows range"))?;
        let eof = FILE_END_OF_FILE_INFO {
            EndOfFile: size as i64,
        };
        if unsafe {
            SetFileInformationByHandle(
                target.0,
                FileEndOfFileInfo,
                (&eof as *const FILE_END_OF_FILE_INFO).cast(),
                size_of::<FILE_END_OF_FILE_INFO>() as u32,
            )
        } == 0
        {
            return Err(win_error(
                unsafe { GetLastError() },
                "set clone file length",
            ));
        }
        // ReFS permits the final partial cluster beyond EOF while retaining the exact
        // logical file size. Each request remains below the API's 4 GiB limit.
        let mut offset = 0;
        while offset < size {
            check_cancelled(cancelled)?;
            let length = (rounded - offset).min(0x8000_0000);
            let request = DUPLICATE_EXTENTS_DATA {
                FileHandle: source.0,
                SourceFileOffset: offset as i64,
                TargetFileOffset: offset as i64,
                ByteCount: length as i64,
            };
            control(
                target.0,
                FSCTL_DUPLICATE_EXTENTS_TO_FILE,
                (&request as *const DUPLICATE_EXTENTS_DATA).cast(),
                size_of::<DUPLICATE_EXTENTS_DATA>() as u32,
                null_mut(),
                0,
            )?;
            offset += length;
        }
    }
    let after = metadata(source.0)?;
    let final_information = file_information(source.0)?;
    if before.LastWriteTime != after.LastWriteTime
        || before.ChangeTime != after.ChangeTime
        || information.nFileSizeHigh != final_information.nFileSizeHigh
        || information.nFileSizeLow != final_information.nFileSizeLow
    {
        return Err(native_error(
            "path-mismatch",
            "clone source changed while cloning",
        ));
    }
    set_metadata(target.0, before)
}

fn copy_tree(
    source: Arc<Directory>,
    target: Arc<Directory>,
    cancelled: &AtomicBool,
    concurrency: usize,
) -> NativeResult<()> {
    let concurrency = concurrency.clamp(1, 32);
    let (sender, receiver) = mpsc::sync_channel::<FileJob>(concurrency * 4);
    let receiver = Mutex::new(receiver);
    let failed = AtomicBool::new(false);
    let first_error = Mutex::new(None);
    let mut directories = Vec::new();
    std::thread::scope(|scope| -> NativeResult<()> {
        let mut workers = Vec::new();
        for _ in 0..concurrency {
            workers.push(scope.spawn(|| {
                loop {
                    let job = receiver.lock().unwrap().recv();
                    let Ok(job) = job else {
                        break;
                    };
                    if failed.load(Ordering::Acquire) {
                        continue;
                    }
                    if let Err(error) = clone_file(job, cancelled) {
                        failed.store(true, Ordering::Release);
                        first_error.lock().unwrap().get_or_insert(error);
                    }
                }
            }));
        }
        let traversal: NativeResult<()> = (|| {
            let mut pending = vec![(source, target)];
            while let Some((source, target)) = pending.pop() {
                check_cancelled(cancelled)?;
                if failed.load(Ordering::Acquire) {
                    break;
                }
                let info = metadata(source.0.0)?;
                reject_named_streams(source.0.0)?;
                let volume = handle_identity(source.0.0)?.0;
                for (name, attributes, file_id) in list_directory_entries(source.0.0)? {
                    check_cancelled(cancelled)?;
                    if failed.load(Ordering::Acquire) {
                        break;
                    }
                    validate_basename(&name)?;
                    let job = FileJob {
                        source_parent: source.clone(),
                        target_parent: target.clone(),
                        name,
                        attributes,
                        file_id,
                        volume,
                    };
                    if attributes & FILE_ATTRIBUTE_DIRECTORY != 0
                        && attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
                    {
                        let child = Arc::new(Directory(open_source(&job)?.0));
                        let destination = create_directory(target.0.0, &job.name)?;
                        pending.push((child, destination));
                    } else {
                        sender
                            .send(job)
                            .map_err(|_| native_error("EIO", "clone worker queue closed"))?;
                    }
                }
                directories.push((target, info));
            }
            Ok(())
        })();
        if traversal.is_err() {
            failed.store(true, Ordering::Release);
        }
        drop(sender);
        // All writes must settle before cancellation or error becomes visible to JS.
        for worker in workers {
            worker
                .join()
                .map_err(|_| native_error("EIO", "clone worker panicked"))?;
        }
        traversal?;
        if let Some(error) = first_error.lock().unwrap().take() {
            return Err(error);
        }
        check_cancelled(cancelled)?;
        for (directory, info) in directories.into_iter().rev() {
            check_cancelled(cancelled)?;
            set_metadata(directory.0.0, info)?;
        }
        Ok(())
    })
}

pub(crate) fn clone_tree(
    source_fd: i32,
    parent_fd: i32,
    basename: &str,
    cancelled: &AtomicBool,
    concurrency: usize,
) -> NativeResult<()> {
    validate_basename(basename)?;
    check_cancelled(cancelled)?;
    let source_handle = root_handle(source_fd)?;
    let parent_handle = root_handle(parent_fd)?;
    let source_identity = handle_identity(source_handle)?;
    let parent_identity = handle_identity(parent_handle)?;
    if !source_identity.2
        || !parent_identity.2
        || handle_is_reparse(source_handle)?
        || handle_is_reparse(parent_handle)?
    {
        return Err(native_error(
            "ENOTDIR",
            "clone requires pinned ordinary directories",
        ));
    }
    if source_identity.0 != parent_identity.0 {
        return Err(native_error("EXDEV", "ReFS clone requires the same volume"));
    }
    if !is_refs(parent_handle)? {
        return Err(native_error("ENOTSUP", "directory cloning requires ReFS"));
    }
    // The facade gives this operation its own pinned directory descriptor. Duplicate
    // its ownership for the worker scope without re-resolving any source pathname.
    let process = unsafe { GetCurrentProcess() };
    let mut source = null_mut();
    if unsafe {
        DuplicateHandle(
            process,
            source_handle,
            process,
            &mut source,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(win_error(
            unsafe { GetLastError() },
            "duplicate pinned clone source",
        ));
    }
    let source = Arc::new(Directory(OwnedHandle(source)));
    let target = create_directory(parent_handle, basename)?;
    if let Err(error) = copy_tree(source, target.clone(), cancelled, concurrency) {
        let cleanup =
            remove_directory_handle(target.0.0).and_then(|()| mark_handle_for_deletion(target.0.0));
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup) => Err(native_error(
                error.status,
                format!("{}; remove partial clone: {}", error.reason, cleanup.reason),
            )),
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_WRITE};
    use windows_sys::Win32::System::Ioctl::FSCTL_GET_RETRIEVAL_POINTERS;

    fn directory(path: &Path) -> File {
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
    }

    fn descriptor(file: &File) -> i32 {
        // Unit tests run without Node/libuv. The shared Windows resolver accepts
        // direct HANDLEs, as it does for other native Windows boundary tests.
        i32::try_from(file.as_raw_handle() as isize).unwrap()
    }

    fn marker(path: &Path, offset: u64) -> [u8; 16] {
        let mut file = File::open(path).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        let mut bytes = [0_u8; 16];
        file.read_exact(&mut bytes).unwrap();
        bytes
    }

    fn first_extent(file: &File) -> i64 {
        let vcn = 0_i64;
        let mut output = [0_u64; 64];
        let bytes = control(
            file.as_raw_handle(),
            FSCTL_GET_RETRIEVAL_POINTERS,
            (&vcn as *const i64).cast(),
            size_of::<i64>() as u32,
            output.as_mut_ptr().cast(),
            size_of_val(&output) as u32,
        )
        .unwrap();
        assert!(bytes >= 32);
        // RETRIEVAL_POINTERS_BUFFER: count/padding, starting VCN, next VCN, LCN.
        let lcn = output[3] as i64;
        assert!(lcn >= 0, "the leading marker must have an allocated extent");
        lcn
    }

    #[test]
    fn refs_tree_clones_large_sparse_files_and_rejects_lossy_sources() {
        let explicit = std::env::var_os("FS_SAFE_CLONE_TEST_ROOT");
        let base =
            fs::canonicalize(explicit.clone().map_or_else(std::env::temp_dir, Into::into)).unwrap();
        let base_handle = directory(&base);
        if !is_refs(base_handle.as_raw_handle()).unwrap() {
            assert!(explicit.is_none(), "FS_SAFE_CLONE_TEST_ROOT requires ReFS");
            eprintln!("ReFS unavailable; set FS_SAFE_CLONE_TEST_ROOT to exercise the sparse clone");
            return;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = base.join(format!(
            "fs-safe-refs-native-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let owned = fs::canonicalize(&root).unwrap();
        assert_eq!(owned.parent(), Some(base.as_path()));
        {
            let parent = directory(&root);
            let parent_fd = descriptor(&parent);
            create_source(parent_fd, "source").unwrap();
            let source_path = root.join("source");
            let source = directory(&source_path);
            let source_fd = descriptor(&source);
            let source_file = source_path.join("large");
            let size = 0x8000_0000_u64 + 4097;
            let offsets = [0, 0x8000_0000 - 16, size - 16];
            {
                let mut file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&source_file)
                    .unwrap();
                control(
                    file.as_raw_handle(),
                    FSCTL_SET_SPARSE,
                    null(),
                    0,
                    null_mut(),
                    0,
                )
                .unwrap();
                file.set_len(size).unwrap();
                for (index, offset) in offsets.into_iter().enumerate() {
                    file.seek(SeekFrom::Start(offset)).unwrap();
                    file.write_all(&[17 + index as u8; 16]).unwrap();
                }
            }
            let cancelled = AtomicBool::new(false);
            clone_tree(source_fd, parent_fd, "copy", &cancelled, 8).unwrap();
            let copied = root.join("copy/large");
            assert_eq!(fs::metadata(&copied).unwrap().len(), size);
            assert_eq!(
                fs::metadata(&copied).unwrap().modified().unwrap(),
                fs::metadata(&source_file).unwrap().modified().unwrap()
            );
            for offset in offsets {
                assert_eq!(marker(&copied, offset), marker(&source_file, offset));
            }
            assert_eq!(
                first_extent(&File::open(&copied).unwrap()),
                first_extent(&File::open(&source_file).unwrap())
            );
            {
                let mut file = OpenOptions::new().write(true).open(&copied).unwrap();
                file.seek(SeekFrom::Start(size - 16)).unwrap();
                file.write_all(&[99; 16]).unwrap();
            }
            assert_eq!(marker(&source_file, size - 16), [19; 16]);
            assert_eq!(marker(&copied, size - 16), [99; 16]);
            {
                let _writer = OpenOptions::new().write(true).open(&source_file).unwrap();
                let error =
                    clone_tree(source_fd, parent_fd, "writer-copy", &cancelled, 8).unwrap_err();
                assert!(error.reason.contains("Windows error 32"), "{error}");
            }
            assert!(!root.join("writer-copy").exists());
            let named = source_path.join("large:metadata");
            fs::write(&named, b"named stream data").unwrap();
            let error = clone_tree(source_fd, parent_fd, "ads-copy", &cancelled, 8).unwrap_err();
            assert_eq!(error.status, "ENOTSUP");
            assert!(!root.join("ads-copy").exists());
            assert_eq!(fs::read(&named).unwrap(), b"named stream data");
            assert_eq!(marker(&source_file, size - 16), [19; 16]);
        }
        // Only this test's exclusively created, still-identical directory is disposable.
        assert_eq!(fs::canonicalize(&root).unwrap(), owned);
        assert_eq!(owned.parent(), Some(base.as_path()));
        fs::remove_dir_all(root).unwrap();
    }
}
