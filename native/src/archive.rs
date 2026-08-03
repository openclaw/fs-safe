use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Buffer, Task};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

use crate::tar_meter::TarMetadataMeter;
use crate::{NativeResult, native_error, platform, validate_portable_relative_path};

#[napi(object)]
pub struct NativeArchiveEntry {
    pub index: u32,
    pub path: String,
    pub kind: String,
    pub size: f64,
    pub mode: u32,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeArchivePlanEntry {
    pub index: u32,
    pub path: String,
    pub kind: String,
    pub size: f64,
    pub mode: u32,
}

#[derive(Debug)]
pub struct ArchiveEntryData {
    index: u32,
    path: String,
    kind: String,
    size: u64,
    mode: u32,
}

#[derive(Clone, Copy)]
enum ArchiveFormat {
    Tar,
    TarZstd,
    TarBzip2,
    Zip,
}

#[derive(Clone, Copy)]
struct InspectLimits {
    max_entries: usize,
    max_meta_entry_bytes: u64,
    max_manifest_bytes: u64,
}

struct CancellationReader<R> {
    inner: R,
    cancelled: Arc<AtomicBool>,
}

impl<R: Read> Read for CancellationReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "archive operation aborted",
            ));
        }
        self.inner.read(buffer)
    }
}

fn parse_format(value: &str) -> NativeResult<ArchiveFormat> {
    match value {
        "tar" => Ok(ArchiveFormat::Tar),
        "tar-zstd" => Ok(ArchiveFormat::TarZstd),
        "tar-bzip2" => Ok(ArchiveFormat::TarBzip2),
        "zip" => Ok(ArchiveFormat::Zip),
        _ => Err(native_error(
            "EINVAL",
            format!("unsupported native archive kind: {value}"),
        )),
    }
}

fn io_error(operation: &str, error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{operation}: {error}"))
}

fn open_tar_reader(
    path: &str,
    format: ArchiveFormat,
    cancelled: Arc<AtomicBool>,
    max_meta_entry_bytes: u64,
) -> Result<Box<dyn Read + Send>> {
    let mut file = File::open(path).map_err(|error| io_error("open archive", error))?;
    let decoded: Box<dyn Read + Send> = match format {
        ArchiveFormat::TarZstd => Box::new(CancellationReader {
            inner: zstd::stream::read::Decoder::new(file)
                .map_err(|error| io_error("open zstd archive", error))?,
            cancelled,
        }),
        ArchiveFormat::TarBzip2 => Box::new(CancellationReader {
            inner: bzip2::read::MultiBzDecoder::new(file),
            cancelled,
        }),
        ArchiveFormat::Tar => {
            let mut magic = [0_u8; 2];
            let read = file
                .read(&mut magic)
                .map_err(|error| io_error("read archive", error))?;
            file.seek(SeekFrom::Start(0))
                .map_err(|error| io_error("rewind archive", error))?;
            if read == 2 && magic == [0x1f, 0x8b] {
                Box::new(CancellationReader {
                    inner: flate2::read::MultiGzDecoder::new(file),
                    cancelled,
                })
            } else {
                Box::new(CancellationReader {
                    inner: file,
                    cancelled,
                })
            }
        }
        ArchiveFormat::Zip => {
            return Err(Error::new(Status::InvalidArg, "zip is not a tar stream"));
        }
    };
    Ok(Box::new(TarMetadataMeter::new(
        decoded,
        max_meta_entry_bytes,
    )))
}

fn tar_kind(entry_type: tar::EntryType) -> &'static str {
    if entry_type.is_dir() {
        "directory"
    } else if entry_type.is_file() || entry_type.is_contiguous() {
        "file"
    } else if entry_type.is_gnu_sparse() {
        "sparse"
    } else if entry_type.is_symlink() {
        "symlink"
    } else if entry_type.is_hard_link() {
        "hardlink"
    } else {
        "other"
    }
}

fn checked_path(path: std::borrow::Cow<'_, std::path::Path>) -> Result<String> {
    path.into_owned()
        .into_os_string()
        .into_string()
        .map_err(|_| Error::new(Status::InvalidArg, "archive entry path is not valid UTF-8"))
}

fn inspect_tar(
    path: &str,
    format: ArchiveFormat,
    limits: InspectLimits,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ArchiveEntryData>> {
    let mut archive = tar::Archive::new(open_tar_reader(
        path,
        format,
        Arc::clone(&cancelled),
        limits.max_meta_entry_bytes,
    )?);
    let entries = archive
        .entries()
        .map_err(|error| io_error("read tar entries", error))?;
    let mut result = Vec::new();
    let mut manifest_bytes = 0_u64;
    for (index, entry) in entries.enumerate() {
        check_cancelled(&cancelled)?;
        let entry = entry.map_err(|error| io_error("read tar entry", error))?;
        let header = entry.header();
        check_manifest_count(index + 1, limits)?;
        let size = entry.size();
        let path = checked_path(
            entry
                .path()
                .map_err(|error| io_error("read tar path", error))?,
        )?;
        add_manifest_path_bytes(&mut manifest_bytes, &path, limits)?;
        result.push(ArchiveEntryData {
            index: u32::try_from(index)
                .map_err(|_| Error::new(Status::InvalidArg, "too many archive entries"))?,
            path,
            kind: tar_kind(header.entry_type()).to_owned(),
            size,
            mode: header.mode().unwrap_or(0),
        });
    }
    Ok(result)
}

fn zip_kind(file: &zip::read::ZipFile<'_, File>) -> &'static str {
    let mode = file.unix_mode().unwrap_or(0);
    if mode & 0o170000 == 0o120000 {
        "symlink"
    } else if file.is_dir() {
        "directory"
    } else if file.is_file() {
        "file"
    } else {
        "other"
    }
}

fn inspect_zip(
    path: &str,
    limits: InspectLimits,
    cancelled: &AtomicBool,
) -> Result<Vec<ArchiveEntryData>> {
    zip_entry_count(path, limits.max_entries)?;
    let file = File::open(path).map_err(|error| io_error("open zip archive", error))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| io_error("read zip archive", error))?;
    let mut result = Vec::with_capacity(archive.len());
    let mut manifest_bytes = 0_u64;
    for index in 0..archive.len() {
        check_cancelled(cancelled)?;
        let file = archive
            .by_index(index)
            .map_err(|error| io_error("read zip entry", error))?;
        add_manifest_path_bytes(&mut manifest_bytes, file.name(), limits)?;
        result.push(ArchiveEntryData {
            index: u32::try_from(index)
                .map_err(|_| Error::new(Status::InvalidArg, "too many archive entries"))?,
            path: file.name().to_owned(),
            kind: zip_kind(&file).to_owned(),
            size: file.size(),
            mode: file.unix_mode().unwrap_or(0),
        });
    }
    Ok(result)
}

fn inspect(
    path: &str,
    format: ArchiveFormat,
    limits: InspectLimits,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ArchiveEntryData>> {
    match format {
        ArchiveFormat::Zip => inspect_zip(path, limits, &cancelled),
        _ => inspect_tar(path, format, limits, cancelled),
    }
}

fn limit_error(code: &'static str) -> Error {
    Error::new(Status::GenericFailure, code)
}

fn check_manifest_count(count: usize, limits: InspectLimits) -> Result<()> {
    if count > limits.max_entries {
        return Err(limit_error("archive-entry-count-exceeds-limit"));
    }
    Ok(())
}

fn add_manifest_path_bytes(total: &mut u64, path: &str, limits: InspectLimits) -> Result<()> {
    *total = total
        .checked_add(path.len() as u64)
        .ok_or_else(|| limit_error("archive-manifest-size-exceeds-limit"))?;
    if *total > limits.max_manifest_bytes {
        return Err(limit_error("archive-manifest-size-exceeds-limit"));
    }
    Ok(())
}

fn zip_entry_count(path: &str, max_entries: usize) -> Result<u64> {
    let mut file = File::open(path).map_err(|error| io_error("open zip archive", error))?;
    let length = file
        .metadata()
        .map_err(|error| io_error("stat zip archive", error))?
        .len();
    let tail_size = length.min(65_557) as usize;
    let mut tail = vec![0_u8; tail_size];
    file.seek(SeekFrom::End(-(tail_size as i64)))
        .and_then(|_| file.read_exact(&mut tail))
        .map_err(|error| io_error("read zip directory", error))?;
    for eocd in (0..tail.len().saturating_sub(21)).rev() {
        if tail[eocd..eocd + 4] != [0x50, 0x4b, 0x05, 0x06] {
            continue;
        }
        let comment_length = u16::from_le_bytes([tail[eocd + 20], tail[eocd + 21]]) as usize;
        if eocd + 22 + comment_length != tail.len() {
            continue;
        }
        let mut count = u16::from_le_bytes([tail[eocd + 10], tail[eocd + 11]]) as u64;
        let mut directory_size =
            u32::from_le_bytes(tail[eocd + 12..eocd + 16].try_into().unwrap()) as u64;
        let mut directory_offset =
            u32::from_le_bytes(tail[eocd + 16..eocd + 20].try_into().unwrap()) as u64;
        let absolute_eocd = length - tail_size as u64 + eocd as u64;
        let mut expected_directory_end = absolute_eocd;
        if count == u16::MAX as u64
            || directory_size == u32::MAX as u64
            || directory_offset == u32::MAX as u64
        {
            if eocd < 20 || tail[eocd - 20..eocd - 16] != [0x50, 0x4b, 0x06, 0x07] {
                continue;
            }
            let record_offset = u64::from_le_bytes(tail[eocd - 12..eocd - 4].try_into().unwrap());
            let mut record = [0_u8; 56];
            if file
                .seek(SeekFrom::Start(record_offset))
                .and_then(|_| file.read_exact(&mut record))
                .is_err()
                || record[..4] != [0x50, 0x4b, 0x06, 0x06]
            {
                continue;
            }
            count = u64::from_le_bytes(record[32..40].try_into().unwrap());
            directory_size = u64::from_le_bytes(record[40..48].try_into().unwrap());
            directory_offset = u64::from_le_bytes(record[48..56].try_into().unwrap());
            expected_directory_end = record_offset;
        }
        if count > max_entries as u64 {
            return Err(limit_error("archive-entry-count-exceeds-limit"));
        }
        if directory_offset.checked_add(directory_size) != Some(expected_directory_end) {
            continue;
        }
        let parsed = count_central_directory_entries(
            &mut file,
            directory_offset,
            directory_size,
            max_entries,
        )?;
        if parsed == count {
            return Ok(parsed);
        }
    }
    Err(Error::new(
        Status::InvalidArg,
        "valid zip end-of-central-directory record missing",
    ))
}

fn count_central_directory_entries(
    file: &mut File,
    offset: u64,
    size: u64,
    max_entries: usize,
) -> Result<u64> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_error("seek zip directory", error))?;
    let mut consumed = 0_u64;
    let mut count = 0_u64;
    while consumed < size {
        let mut header = [0_u8; 46];
        file.read_exact(&mut header)
            .map_err(|error| io_error("read zip directory entry", error))?;
        if header[..4] != [0x50, 0x4b, 0x01, 0x02] {
            return Err(Error::new(
                Status::InvalidArg,
                "invalid zip central directory entry",
            ));
        }
        let variable = u16::from_le_bytes([header[28], header[29]]) as u64
            + u16::from_le_bytes([header[30], header[31]]) as u64
            + u16::from_le_bytes([header[32], header[33]]) as u64;
        consumed = consumed
            .checked_add(46 + variable)
            .ok_or_else(|| Error::new(Status::InvalidArg, "zip directory size overflow"))?;
        if consumed > size {
            return Err(Error::new(
                Status::InvalidArg,
                "truncated zip central directory",
            ));
        }
        file.seek(SeekFrom::Current(variable as i64))
            .map_err(|error| io_error("skip zip directory entry", error))?;
        count += 1;
        if count > max_entries as u64 {
            return Err(limit_error("archive-entry-count-exceeds-limit"));
        }
    }
    Ok(count)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(Error::new(Status::Cancelled, "archive operation aborted"))
    } else {
        Ok(())
    }
}

fn cancellation(signal: &AbortSignal) -> Arc<AtomicBool> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let callback = Arc::clone(&cancelled);
    signal.on_abort(move || callback.store(true, Ordering::Relaxed));
    cancelled
}

pub struct InspectTask {
    path: String,
    format: ArchiveFormat,
    limits: InspectLimits,
    cancelled: Arc<AtomicBool>,
}

impl Task for InspectTask {
    type Output = Vec<ArchiveEntryData>;
    type JsValue = Vec<NativeArchiveEntry>;

    fn compute(&mut self) -> Result<Self::Output> {
        inspect(
            &self.path,
            self.format,
            self.limits,
            Arc::clone(&self.cancelled),
        )
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output
            .into_iter()
            .map(|entry| NativeArchiveEntry {
                index: entry.index,
                path: entry.path,
                kind: entry.kind,
                size: entry.size as f64,
                mode: entry.mode,
            })
            .collect())
    }
}

#[napi(js_name = "inspectArchiveNative")]
pub fn inspect_archive_native(
    path: String,
    kind: String,
    max_entries: u32,
    max_meta_entry_bytes: f64,
    max_manifest_bytes: f64,
    signal: AbortSignal,
) -> Result<AsyncTask<InspectTask>> {
    let format =
        parse_format(&kind).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    let limits = InspectLimits {
        max_entries: max_entries as usize,
        max_meta_entry_bytes: checked_limit(max_meta_entry_bytes, "maxMetaEntryBytes")?,
        max_manifest_bytes: checked_limit(max_manifest_bytes, "maxManifestBytes")?,
    };
    let cancelled = cancellation(&signal);
    Ok(AsyncTask::with_signal(
        InspectTask {
            path,
            format,
            limits,
            cancelled,
        },
        signal,
    ))
}

fn checked_limit(value: f64, label: &str) -> Result<u64> {
    if !value.is_finite() || value < 0.0 || value > u64::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{label} is out of range"),
        ));
    }
    Ok(value as u64)
}

fn plan_map(plan: Vec<NativeArchivePlanEntry>) -> Result<HashMap<usize, NativeArchivePlanEntry>> {
    let mut entries = HashMap::with_capacity(plan.len());
    for entry in plan {
        validate_portable_relative_path(&entry.path, false)
            .map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
        if entry.kind != "file" && entry.kind != "directory" {
            return Err(Error::new(
                Status::InvalidArg,
                "native archive plan only accepts files and directories",
            ));
        }
        let index = entry.index as usize;
        if entries.insert(index, entry).is_some() {
            return Err(Error::new(
                Status::InvalidArg,
                "native archive plan contains a duplicate index",
            ));
        }
    }
    Ok(entries)
}

fn ensure_parent(root_fd: i32, path: &str) -> Result<()> {
    if let Some((parent, _)) = path.rsplit_once('/') {
        platform::mkdir_beneath(root_fd, parent, 0o700)
            .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
    }
    Ok(())
}

fn extract_tar(
    path: &str,
    format: ArchiveFormat,
    root_fd: i32,
    mut plan: HashMap<usize, NativeArchivePlanEntry>,
    cancelled: Arc<AtomicBool>,
    max_meta_entry_bytes: u64,
) -> Result<()> {
    let mut archive = tar::Archive::new(open_tar_reader(
        path,
        format,
        Arc::clone(&cancelled),
        max_meta_entry_bytes,
    )?);
    let entries = archive
        .entries()
        .map_err(|error| io_error("read tar entries", error))?;
    let mut directories = Vec::new();
    for (index, entry) in entries.enumerate() {
        check_cancelled(&cancelled)?;
        let Some(item) = plan.remove(&index) else {
            continue;
        };
        let mut entry = entry.map_err(|error| io_error("read tar entry", error))?;
        let actual_kind = tar_kind(entry.header().entry_type());
        if actual_kind != item.kind || entry.size() as f64 != item.size {
            return Err(Error::new(
                Status::InvalidArg,
                "archive entry changed after policy evaluation",
            ));
        }
        if item.kind == "directory" {
            platform::mkdir_beneath(root_fd, &item.path, 0o700)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
            directories.push((item.path, item.mode));
        } else {
            ensure_parent(root_fd, &item.path)?;
            let size = entry.size();
            let mut reader = CancellationReader {
                inner: &mut entry,
                cancelled: Arc::clone(&cancelled),
            };
            platform::write_archive_file(root_fd, &item.path, &mut reader, size, item.mode)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
        }
    }
    finish_directories(root_fd, directories)?;
    if !plan.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "archive entries disappeared after policy evaluation",
        ));
    }
    Ok(())
}

fn extract_zip(
    path: &str,
    root_fd: i32,
    mut plan: HashMap<usize, NativeArchivePlanEntry>,
    cancelled: Arc<AtomicBool>,
) -> Result<()> {
    let file = File::open(path).map_err(|error| io_error("open zip archive", error))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| io_error("read zip archive", error))?;
    let mut directories = Vec::new();
    for index in 0..archive.len() {
        check_cancelled(&cancelled)?;
        let Some(item) = plan.remove(&index) else {
            continue;
        };
        let mut file = archive
            .by_index(index)
            .map_err(|error| io_error("read zip entry", error))?;
        let actual_kind = zip_kind(&file);
        if actual_kind != item.kind || file.size() as f64 != item.size {
            return Err(Error::new(
                Status::InvalidArg,
                "archive entry changed after policy evaluation",
            ));
        }
        if item.kind == "directory" {
            platform::mkdir_beneath(root_fd, &item.path, 0o700)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
            directories.push((item.path, item.mode));
        } else {
            ensure_parent(root_fd, &item.path)?;
            let size = file.size();
            let mut reader = CancellationReader {
                inner: &mut file,
                cancelled: Arc::clone(&cancelled),
            };
            platform::write_archive_file(root_fd, &item.path, &mut reader, size, item.mode)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
        }
    }
    finish_directories(root_fd, directories)?;
    if !plan.is_empty() {
        return Err(Error::new(
            Status::InvalidArg,
            "archive entries disappeared after policy evaluation",
        ));
    }
    Ok(())
}

fn finish_directories(root_fd: i32, mut directories: Vec<(String, u32)>) -> Result<()> {
    directories.sort_by_key(|(path, _)| std::cmp::Reverse(path.matches('/').count()));
    for (path, mode) in directories {
        platform::chmod_beneath(root_fd, &path, mode)
            .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
    }
    Ok(())
}

pub struct ExtractTask {
    path: String,
    format: ArchiveFormat,
    root_fd: i32,
    plan: Option<Vec<NativeArchivePlanEntry>>,
    cancelled: Arc<AtomicBool>,
    max_meta_entry_bytes: u64,
}

impl Task for ExtractTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        let plan = plan_map(self.plan.take().unwrap_or_default())?;
        match self.format {
            ArchiveFormat::Zip => {
                extract_zip(&self.path, self.root_fd, plan, Arc::clone(&self.cancelled))
            }
            _ => extract_tar(
                &self.path,
                self.format,
                self.root_fd,
                plan,
                Arc::clone(&self.cancelled),
                self.max_meta_entry_bytes,
            ),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "extractArchiveNative")]
pub fn extract_archive_native(
    path: String,
    kind: String,
    root_fd: i32,
    plan: Vec<NativeArchivePlanEntry>,
    max_meta_entry_bytes: f64,
    signal: AbortSignal,
) -> Result<AsyncTask<ExtractTask>> {
    let format =
        parse_format(&kind).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    let cancelled = cancellation(&signal);
    let max_meta_entry_bytes = checked_limit(max_meta_entry_bytes, "maxMetaEntryBytes")?;
    Ok(AsyncTask::with_signal(
        ExtractTask {
            path,
            format,
            root_fd,
            plan: Some(plan),
            cancelled,
            max_meta_entry_bytes,
        },
        signal,
    ))
}

fn read_tar_entry(
    path: &str,
    format: ArchiveFormat,
    requested: &str,
    max_bytes: u64,
    cancelled: Arc<AtomicBool>,
    max_meta_entry_bytes: u64,
    max_entries: usize,
) -> Result<Vec<u8>> {
    let mut archive = tar::Archive::new(open_tar_reader(
        path,
        format,
        Arc::clone(&cancelled),
        max_meta_entry_bytes,
    )?);
    for (index, entry) in archive
        .entries()
        .map_err(|error| io_error("read tar entries", error))?
        .enumerate()
    {
        if index >= max_entries {
            return Err(limit_error("archive-entry-count-exceeds-limit"));
        }
        check_cancelled(&cancelled)?;
        let mut entry = entry.map_err(|error| io_error("read tar entry", error))?;
        if checked_path(
            entry
                .path()
                .map_err(|error| io_error("read tar path", error))?,
        )? != requested
        {
            continue;
        }
        if tar_kind(entry.header().entry_type()) != "file" {
            if entry.header().entry_type().is_gnu_sparse() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "archive-header-invalid: GNU sparse entries are not supported",
                ));
            }
            return Err(Error::new(
                Status::InvalidArg,
                format!("archive entry is not a file: {requested}"),
            ));
        }
        return read_bounded(&mut entry, max_bytes, cancelled);
    }
    Err(Error::new(
        Status::InvalidArg,
        format!("archive entry not found: {requested}"),
    ))
}

fn read_zip_entry(
    path: &str,
    requested: &str,
    max_bytes: u64,
    max_entries: usize,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    zip_entry_count(path, max_entries)?;
    let file = File::open(path).map_err(|error| io_error("open zip archive", error))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| io_error("read zip archive", error))?;
    let mut entry = archive.by_name(requested).map_err(|_| {
        Error::new(
            Status::InvalidArg,
            format!("archive entry not found: {requested}"),
        )
    })?;
    if zip_kind(&entry) != "file" {
        return Err(Error::new(
            Status::InvalidArg,
            format!("archive entry is not a file: {requested}"),
        ));
    }
    read_bounded(&mut entry, max_bytes, cancelled)
}

fn read_bounded(
    reader: &mut impl Read,
    max_bytes: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    let capacity = usize::try_from(max_bytes.min(1024 * 1024)).unwrap_or(0);
    let mut output = Vec::with_capacity(capacity);
    CancellationReader {
        inner: reader,
        cancelled,
    }
    .take(max_bytes.saturating_add(1))
    .read_to_end(&mut output)
    .map_err(|error| io_error("read archive entry", error))?;
    if output.len() as u64 > max_bytes {
        return Err(Error::new(
            Status::GenericFailure,
            "archive-entry-extracted-size-exceeds-limit",
        ));
    }
    Ok(output)
}

pub struct ReadEntryTask {
    path: String,
    format: ArchiveFormat,
    requested: String,
    max_bytes: u64,
    max_entries: usize,
    cancelled: Arc<AtomicBool>,
    max_meta_entry_bytes: u64,
}

impl Task for ReadEntryTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;
    fn compute(&mut self) -> Result<Self::Output> {
        check_cancelled(&self.cancelled)?;
        match self.format {
            ArchiveFormat::Zip => read_zip_entry(
                &self.path,
                &self.requested,
                self.max_bytes,
                self.max_entries,
                Arc::clone(&self.cancelled),
            ),
            _ => read_tar_entry(
                &self.path,
                self.format,
                &self.requested,
                self.max_bytes,
                Arc::clone(&self.cancelled),
                self.max_meta_entry_bytes,
                self.max_entries,
            ),
        }
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(js_name = "readArchiveEntryNative")]
pub fn read_archive_entry_native(
    path: String,
    kind: String,
    requested: String,
    max_bytes: f64,
    max_entries: u32,
    max_meta_entry_bytes: f64,
    signal: AbortSignal,
) -> Result<AsyncTask<ReadEntryTask>> {
    if !max_bytes.is_finite() || max_bytes < 0.0 || max_bytes > u64::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            "maxBytes must be a non-negative finite number",
        ));
    }
    let format =
        parse_format(&kind).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    let cancelled = cancellation(&signal);
    let max_meta_entry_bytes = checked_limit(max_meta_entry_bytes, "maxMetaEntryBytes")?;
    Ok(AsyncTask::with_signal(
        ReadEntryTask {
            path,
            format,
            requested,
            max_bytes: max_bytes as u64,
            max_entries: max_entries as usize,
            cancelled,
            max_meta_entry_bytes,
        },
        signal,
    ))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static TEMP_PATH_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn fixture_tar() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut bytes);
            for (name, body) in [
                ("one.txt", b"one".as_slice()),
                ("two.txt", b"two".as_slice()),
            ] {
                let mut header = tar::Header::new_ustar();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, body).unwrap();
            }
            builder.finish().unwrap();
        }
        bytes
    }

    fn temp_path(suffix: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMP_PATH_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "fs-safe-archive-{}-{nonce}-{sequence}.{suffix}",
            std::process::id()
        ))
    }

    fn limits(max_entries: usize) -> InspectLimits {
        InspectLimits {
            max_entries,
            max_meta_entry_bytes: 1024 * 1024,
            max_manifest_bytes: 16 * 1024 * 1024,
        }
    }

    fn gzip(part: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(part).unwrap();
        encoder.finish().unwrap()
    }

    fn bzip(part: &[u8]) -> Vec<u8> {
        let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        encoder.write_all(part).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn manifest_is_bounded_before_result_allocation() {
        let path = temp_path("tar");
        std::fs::write(&path, fixture_tar()).unwrap();
        let error = inspect_tar(
            path.to_str().unwrap(),
            ArchiveFormat::Tar,
            limits(1),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert!(error.reason.contains("archive-entry-count-exceeds-limit"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn manifest_paths_and_single_entry_reads_are_bounded() {
        let path = temp_path("tar");
        std::fs::write(&path, fixture_tar()).unwrap();
        let mut bounded = limits(10);
        bounded.max_manifest_bytes = 3;
        let error = inspect_tar(
            path.to_str().unwrap(),
            ArchiveFormat::Tar,
            bounded,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert!(error.reason.contains("archive-manifest-size-exceeds-limit"));

        let error = read_tar_entry(
            path.to_str().unwrap(),
            ArchiveFormat::Tar,
            "missing",
            1024,
            Arc::new(AtomicBool::new(false)),
            1024,
            1,
        )
        .unwrap_err();
        assert!(error.reason.contains("archive-entry-count-exceeds-limit"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cancellation_reader_checks_every_read() {
        let cancelled = Arc::new(AtomicBool::new(true));
        let mut reader = CancellationReader {
            inner: Cursor::new(vec![1_u8; 16]),
            cancelled,
        };
        assert_eq!(
            reader.read(&mut [0_u8; 8]).unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
    }

    #[test]
    fn gzip_and_bzip2_decode_concatenated_members() {
        type FormatFixture = (ArchiveFormat, &'static str, fn(&[u8]) -> Vec<u8>);
        let tar = fixture_tar();
        let formats: [FormatFixture; 2] = [
            (ArchiveFormat::Tar, "tar.gz", gzip),
            (ArchiveFormat::TarBzip2, "tar.bz2", bzip),
        ];
        for (format, suffix, encode) in formats {
            let midpoint = tar.len() / 2;
            let bytes = [encode(&tar[..midpoint]), encode(&tar[midpoint..])].concat();
            let path = temp_path(suffix);
            std::fs::write(&path, bytes).unwrap();
            let entries = inspect_tar(
                path.to_str().unwrap(),
                format,
                limits(10),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
            assert_eq!(entries.len(), 2);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn zip_preflight_rejects_fake_eocd_comment_candidates() {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for name in ["one", "two"] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
        }
        let mut bytes = writer.finish().unwrap().into_inner();
        let real_eocd = bytes
            .windows(4)
            .rposition(|window| window == [0x50, 0x4b, 0x05, 0x06])
            .unwrap();
        bytes[real_eocd + 20..real_eocd + 22].copy_from_slice(&22_u16.to_le_bytes());
        let mut fake = [0_u8; 22];
        fake[..4].copy_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        fake[8..10].copy_from_slice(&1_u16.to_le_bytes());
        fake[10..12].copy_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&fake);
        let path = temp_path("zip");
        std::fs::write(&path, bytes).unwrap();

        let error = zip_entry_count(path.to_str().unwrap(), 1).unwrap_err();
        assert!(error.reason.contains("archive-entry-count-exceeds-limit"));
        assert_eq!(zip_entry_count(path.to_str().unwrap(), 2).unwrap(), 2);
        std::fs::remove_file(path).unwrap();
    }
}
