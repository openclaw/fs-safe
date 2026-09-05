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

use crate::tar_meter::{TarMetadataMeter, TarMeterLimits, MAX_SAFE_INTEGER, MAX_MANIFEST_BYTES};
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
    offset: u64,
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
    tar: TarMeterLimits,
}

#[napi(object)]
pub struct NativeTarLimits {
    pub max_entries: f64,
    pub max_meta_entry_bytes: f64,
    pub max_decoded_bytes: f64,
    pub max_manifest_bytes: f64,
}

impl NativeTarLimits {
    fn checked(self) -> Result<TarMeterLimits> {
        Ok(TarMeterLimits {
            windows_paths: cfg!(windows),
            max_entries: checked_tar_limit(self.max_entries, "maxEntries", u32::MAX as u64)? as usize,
            max_meta_entry_bytes: checked_tar_limit(self.max_meta_entry_bytes, "maxMetaEntryBytes", MAX_SAFE_INTEGER)?,
            max_decoded_bytes: checked_tar_limit(self.max_decoded_bytes, "maxDecodedBytes", MAX_SAFE_INTEGER)?,
            max_manifest_bytes: checked_tar_limit(self.max_manifest_bytes, "maxManifestBytes", MAX_MANIFEST_BYTES)?,
        })
    }
}

fn checked_tar_limit(value: f64, label: &str, maximum: u64) -> Result<u64> {
    // Validate before min/casting: f64::min would otherwise hide NaN, and N-API
    // integer conversion would discard an oversized logical entry count.
    if !value.is_finite() || value < 0.0 {
        return Err(Error::new(Status::InvalidArg, format!("{label} is out of range")));
    }
    Ok(value.min(maximum as f64) as u64)
}

struct CancellationReader<R> {
    inner: R,
    cancelled: Arc<AtomicBool>,
}

impl<R: Read> Read for CancellationReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            // Cancellation is terminal; read_to_end retries Interrupted forever.
            return Err(std::io::Error::other("archive operation aborted"));
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
    limits: TarMeterLimits,
) -> Result<TarMetadataMeter<Box<dyn Read + Send>>> {
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
                    inner: crate::archive_gzip::GzipContainer::new(
                        CancellationReader { inner: file, cancelled: Arc::clone(&cancelled) },
                        Arc::clone(&cancelled),
                    ),
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
    Ok(TarMetadataMeter::new(decoded, limits))
}

fn drain_tar_metadata(reader: &mut impl Read) -> std::io::Result<()> {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        if reader.read(&mut buffer)? == 0 {
            return Ok(());
        }
    }
}

fn inspect_tar(
    path: &str,
    format: ArchiveFormat,
    limits: InspectLimits,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ArchiveEntryData>> {
    let mut reader = open_tar_reader(path, format, cancelled, limits.tar)?;
    let mut result = Vec::new();
    let mut buffer = [0; 65536];
    while reader.read(&mut buffer).map_err(|error| io_error("admit tar", error))? != 0 {
        if let Some(member) = reader.take_member() {
            let kind = member.kind().to_owned();
            result.push(ArchiveEntryData {
                index: result.len() as u32, path: member.path, kind,
                size: member.size, mode: member.mode, offset: member.offset,
            });
        }
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
    zip_entry_count(path, limits.tar.max_entries)?;
    let file = File::open(path).map_err(|error| io_error("open zip archive", error))?;
    // ZIP names live uncompressed in its central directory. Bound retained
    // UTF-8 names by input bytes (CP437 expands at most threefold), not TAR
    // metadata/depth settings. The caller already caps the archive input.
    let max_path_bytes = file.metadata().map_err(|error| io_error("stat zip archive", error))?
        .len().saturating_mul(3);
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| io_error("read zip archive", error))?;
    let mut result = Vec::with_capacity(archive.len());
    let mut manifest_bytes = 0_u64;
    for index in 0..archive.len() {
        check_cancelled(cancelled)?;
        let file = archive
            .by_index(index)
            .map_err(|error| io_error("read zip entry", error))?;
        manifest_bytes = manifest_bytes.checked_add(file.name().len() as u64)
            .filter(|total| *total <= max_path_bytes)
            .ok_or_else(|| limit_error("archive-manifest-size-exceeds-limit"))?;
        result.push(ArchiveEntryData {
            index: u32::try_from(index)
                .map_err(|_| Error::new(Status::InvalidArg, "too many archive entries"))?,
            path: file.name().to_owned(),
            kind: zip_kind(&file).to_owned(),
            size: file.size(),
            mode: file.unix_mode().unwrap_or(0),
            offset: 0,
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
    limits: NativeTarLimits,
    signal: AbortSignal,
) -> Result<AsyncTask<InspectTask>> {
    let format =
        parse_format(&kind).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    let limits = InspectLimits {
        tar: limits.checked()?,
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
    limits: TarMeterLimits,
) -> Result<()> {
    let manifest = inspect_tar(path, format, InspectLimits { tar: limits }, Arc::clone(&cancelled))?;
    let mut reader = open_tar_reader(path, format, Arc::clone(&cancelled), limits)?;
    let mut position = 0;
    let mut directories = Vec::new();
    for entry in manifest {
        check_cancelled(&cancelled)?;
        let Some(item) = plan.remove(&(entry.index as usize)) else { continue; };
        if entry.kind != item.kind || entry.size as f64 != item.size {
            return Err(Error::new(Status::InvalidArg, "archive entry changed after policy evaluation"));
        }
        skip_tar_to(&mut reader, &mut position, entry.offset)?;
        if item.kind == "directory" {
            platform::mkdir_beneath(root_fd, &item.path, 0o700)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
            directories.push((item.path, item.mode));
        } else {
            ensure_parent(root_fd, &item.path)?;
            let mut payload = (&mut reader).take(entry.size);
            platform::write_archive_file(root_fd, &item.path, &mut payload, entry.size, item.mode)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
            if payload.limit() != 0 { return Err(Error::new(Status::InvalidArg, "truncated TAR payload")); }
            position += entry.size;
        }
    }
    drain_tar_metadata(&mut reader).map_err(|error| io_error("finish tar", error))?;
    if !plan.is_empty() {
        return Err(Error::new(Status::InvalidArg, "archive entries disappeared after policy evaluation"));
    }
    finish_directories(root_fd, directories)
}

fn skip_tar_to(reader: &mut impl Read, position: &mut u64, offset: u64) -> Result<()> {
    let length = offset.checked_sub(*position)
        .ok_or_else(|| Error::new(Status::InvalidArg, "invalid admitted TAR range"))?;
    let copied = std::io::copy(&mut reader.take(length), &mut std::io::sink())
        .map_err(|error| io_error("replay tar", error))?;
    if copied != length { return Err(Error::new(Status::InvalidArg, "truncated TAR range")); }
    *position = offset;
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
    limits: TarMeterLimits,
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
                self.limits,
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
    limits: NativeTarLimits,
    signal: AbortSignal,
) -> Result<AsyncTask<ExtractTask>> {
    let format =
        parse_format(&kind).map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    let cancelled = cancellation(&signal);
    let limits = limits.checked()?;
    Ok(AsyncTask::with_signal(
        ExtractTask {
            path,
            format,
            root_fd,
            plan: Some(plan),
            cancelled,
            limits,
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
    limits: TarMeterLimits,
) -> Result<Vec<u8>> {
    let manifest = inspect_tar(path, format, InspectLimits { tar: limits }, Arc::clone(&cancelled))?;
    let member = manifest.iter().find(|entry| entry.path == requested)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("archive entry not found: {requested}")))?;
    if member.kind != "file" {
        return Err(Error::new(Status::InvalidArg, format!("archive entry is not a file: {requested}")));
    }
    if member.size > max_bytes { return Err(limit_error("archive-entry-extracted-size-exceeds-limit")); }
    let mut reader = open_tar_reader(path, format, Arc::clone(&cancelled), limits)?;
    skip_tar_to(&mut reader, &mut 0, member.offset)?;
    let output = read_bounded(&mut (&mut reader).take(member.size), max_bytes, cancelled)?;
    if output.len() as u64 != member.size {
        return Err(Error::new(Status::InvalidArg, "archive-header-invalid: truncated TAR payload"));
    }
    drain_tar_metadata(&mut reader).map_err(|error| io_error("finish tar", error))?;
    Ok(output)
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
    let expected_size = entry.size();
    let output = read_bounded(&mut entry, max_bytes, cancelled)?;
    if output.len() as u64 != expected_size {
        return Err(Error::new(
            Status::InvalidArg,
            "archive-header-invalid: ZIP entry size does not match declared uncompressed size",
        ));
    }
    Ok(output)
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
    limits: TarMeterLimits,
    cancelled: Arc<AtomicBool>,
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
                self.limits.max_entries,
                Arc::clone(&self.cancelled),
            ),
            _ => read_tar_entry(
                &self.path,
                self.format,
                &self.requested,
                self.max_bytes,
                Arc::clone(&self.cancelled),
                self.limits,
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
    limits: NativeTarLimits,
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
    let limits = limits.checked()?;
    Ok(AsyncTask::with_signal(
        ReadEntryTask {
            path,
            format,
            requested,
            max_bytes: max_bytes as u64,
            limits,
            cancelled,
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
            tar: TarMeterLimits {
                windows_paths: cfg!(windows),
                max_entries,
                max_meta_entry_bytes: 1024 * 1024,
                max_decoded_bytes: 768 * 1024 * 1024,
                max_manifest_bytes: MAX_MANIFEST_BYTES,
            },
        }
    }

    fn gzip(part: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(part).unwrap();
        encoder.finish().unwrap()
    }

    fn native_limits(value: f64) -> NativeTarLimits {
        NativeTarLimits {
            max_entries: value,
            max_meta_entry_bytes: value,
            max_decoded_bytes: value,
            max_manifest_bytes: value,
        }
    }

    #[test]
    fn tar_manifest_modes_distinguish_absence_and_signed_binary_for_all_codecs() {
        let binary = |value: i64| {
            let mut field = value.to_be_bytes();
            if value >= 0 { field[0] = 0x80; }
            field
        };
        let fields = [
            ([0; 8], None), ([b' '; 8], None), (*b"0000000\0", Some(0)),
            (binary(0), Some(0)), (binary(0o755), Some(0o755)),
            (binary((1_i64 << 32) + 0o755), Some(0o755)),
            (binary(MAX_SAFE_INTEGER as i64), Some(0o7777)),
            (binary(-1), Some(0o7777)), (binary(-256), Some(0o7400)),
            (binary(-512), Some(0o7000)), (binary(-(MAX_SAFE_INTEGER as i64)), Some(1)),
        ];
        for (mode, expected) in fields {
            for entry_type in [b'0', b'7', b'5', b'D'] {
                let mut header = tar::Header::new_ustar();
                header.set_path("entry").unwrap();
                header.set_entry_type(tar::EntryType::new(entry_type));
                header.set_size(0);
                header.as_old_mut().mode = mode;
                header.set_cksum();
                let bytes = [header.as_bytes().as_slice(), &[0; 1024]].concat();
                for (format, encoded) in [
                    (ArchiveFormat::Tar, bytes.clone()), (ArchiveFormat::Tar, gzip(&bytes)),
                    (ArchiveFormat::TarZstd, zstd::stream::encode_all(bytes.as_slice(), 1).unwrap()),
                    (ArchiveFormat::TarBzip2, bzip(&bytes)),
                ] {
                    let path = temp_path("tar-modes");
                    std::fs::write(&path, encoded).unwrap();
                    let result = inspect_tar(path.to_str().unwrap(), format, limits(10), Arc::new(AtomicBool::new(false)));
                    std::fs::remove_file(path).unwrap();
                    let manifest = result.unwrap();
                    let kind = if matches!(entry_type, b'5' | b'D') { "directory" } else { "file" };
                    assert_eq!(manifest[0].kind, kind);
                    assert_eq!(manifest[0].mode, expected.unwrap_or(if kind == "directory" { 0o755 } else { 0o644 }), "mode={mode:?}, type={entry_type}");
                }
            }
        }
    }

    #[test]
    fn native_tar_limits_clamp_finite_values_before_integer_conversion() {
        for (value, expected_bytes, expected_entries) in [
            (0.0, 0, 0),
            (1.9, 1, 1),
            (u32::MAX as f64, u32::MAX as u64, u32::MAX as usize),
            (u32::MAX as f64 + 1.0, u32::MAX as u64 + 1, u32::MAX as usize),
            (MAX_SAFE_INTEGER as f64, MAX_SAFE_INTEGER, u32::MAX as usize),
            (MAX_SAFE_INTEGER as f64 + 1.0, MAX_SAFE_INTEGER, u32::MAX as usize),
            (f64::MAX, MAX_SAFE_INTEGER, u32::MAX as usize),
        ] {
            let limits = native_limits(value).checked().unwrap();
            assert_eq!(limits.max_entries, expected_entries);
            assert_eq!(limits.max_meta_entry_bytes, expected_bytes);
            assert_eq!(limits.max_decoded_bytes, expected_bytes);
            assert_eq!(limits.max_manifest_bytes, expected_bytes.min(MAX_MANIFEST_BYTES));
        }
    }

    #[test]
    fn native_tar_limits_reject_malformed_fields_before_clamping() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, -0.5] {
            for field in ["maxEntries", "maxMetaEntryBytes", "maxDecodedBytes", "maxManifestBytes"] {
                let mut limits = native_limits(1024.0);
                match field {
                    "maxEntries" => limits.max_entries = value,
                    "maxMetaEntryBytes" => limits.max_meta_entry_bytes = value,
                    "maxDecodedBytes" => limits.max_decoded_bytes = value,
                    "maxManifestBytes" => limits.max_manifest_bytes = value,
                    _ => unreachable!(),
                }
                let error = limits.checked().err().expect("malformed limit was accepted");
                assert_eq!(error.status, Status::InvalidArg);
                assert_eq!(error.reason, format!("{field} is out of range"));
            }
        }
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
        bounded.tar.max_manifest_bytes = 3;
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
            limits(1).tar,
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
            std::io::ErrorKind::Other
        );
    }

    #[test]
    fn metadata_reads_propagate_cancellation_without_retrying() {
        struct CancelAfterRead {
            inner: CancellationReader<Cursor<Vec<u8>>>,
            reads: usize,
        }

        impl Read for CancelAfterRead {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                assert!(self.reads <= 2, "metadata drain retried cancellation");
                let result = self.inner.read(buffer);
                self.inner.cancelled.store(true, Ordering::Relaxed);
                result
            }
        }

        for buffered in [false, true] {
            let mut reader = CancelAfterRead {
                inner: CancellationReader {
                    inner: Cursor::new(vec![0_u8; 16 * 1024]),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
                reads: 0,
            };
            let result = if buffered {
                // tar buffers PAX bodies through read_to_end, unlike our drain.
                reader.read_to_end(&mut Vec::new()).map(|_| ())
            } else {
                drain_tar_metadata(&mut reader)
            };
            let error = result.unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::Other);
            assert_eq!(error.to_string(), "archive operation aborted");
            assert_eq!(reader.reads, 2);
        }
    }

    #[test]
    fn metadata_drain_reaches_eof_and_preserves_trailer_validation() {
        for nonzero in [false, true] {
            let length = 16 * 1024 + 1;
            let mut bytes = vec![0_u8; length];
            bytes[length - 1] = u8::from(nonzero);
            let mut input = Cursor::new(bytes);
            let result = drain_tar_metadata(&mut TarMetadataMeter::new(&mut input, limits(10).tar));
            assert_eq!(input.position(), length as u64);
            if nonzero {
                let error = result.unwrap_err();
                assert!(error.to_string().contains("archive-header-invalid"));
                assert!(error.to_string().contains("nonzero data after TAR EOF"));
            } else {
                result.unwrap();
            }
        }
    }

    #[test]
    fn raw_framing_precedes_the_parser_for_every_codec() {
        let mut tar = fixture_tar();
        // The first invalid raw header must fail before the later trailer.
        tar[148..156].fill(b'0');
        tar.push(1);
        let encoded = [
            (ArchiveFormat::Tar, tar.clone()),
            (ArchiveFormat::Tar, gzip(&tar)),
            (ArchiveFormat::TarZstd, zstd::stream::encode_all(tar.as_slice(), 1).unwrap()),
            (ArchiveFormat::TarBzip2, bzip(&tar)),
        ];
        for (format, bytes) in encoded {
            let path = temp_path("tar-framing");
            std::fs::write(&path, bytes).unwrap();
            let error = inspect_tar(path.to_str().unwrap(), format, limits(10), Arc::new(AtomicBool::new(false))).unwrap_err();
            assert!(error.reason.contains("checksum failure"), "{error}");
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn every_tar_pass_rejects_over_count_headers_without_a_body_for_all_codecs() {
        let regular = fixture_tar();
        let mut pax = tar::Header::new_ustar();
        pax.set_path("PaxHeader").unwrap();
        pax.set_entry_type(tar::EntryType::new(b'x'));
        pax.set_mode(0o644);
        pax.set_size(10);
        pax.set_cksum();
        let pax_prefix = [pax.as_bytes().as_slice(), b"10 size=3\n", &[0; 502]].concat();
        let fixtures = [
            (regular[..512].to_vec(), 0),
            (regular[..1536].to_vec(), 1),
            ([pax_prefix, regular[..1536].to_vec()].concat(), 1),
        ];
        let code = "archive-entry-count-exceeds-limit";
        for (tar, max_entries) in fixtures {
            let encoded = [
                (ArchiveFormat::Tar, tar.clone()),
                (ArchiveFormat::Tar, gzip(&tar)),
                (ArchiveFormat::TarZstd, zstd::stream::encode_all(tar.as_slice(), 1).unwrap()),
                (ArchiveFormat::TarBzip2, bzip(&tar)),
            ];
            for (format, bytes) in encoded {
                let path = temp_path("tar-budget");
                std::fs::write(&path, bytes).unwrap();
                let limits = limits(max_entries);
                let cancelled = Arc::new(AtomicBool::new(false));
                let error = inspect_tar(path.to_str().unwrap(), format, limits, Arc::clone(&cancelled)).unwrap_err();
                assert!(error.reason.contains(code), "{error}");
                // No planned entry means no writes; rejected reader errors
                // must still propagate rather than disappear with the plan.
                let error = extract_tar(path.to_str().unwrap(), format, -1, HashMap::new(), Arc::clone(&cancelled), limits.tar).unwrap_err();
                assert!(error.reason.contains(code), "{error}");
                let error = read_tar_entry(path.to_str().unwrap(), format, "absent", 1, cancelled, limits.tar).unwrap_err();
                assert!(error.reason.contains(code), "{error}");
                std::fs::remove_file(path).unwrap();
            }
        }
    }

    #[test]
    fn decoded_limit_bounds_every_native_tar_pass_for_all_codecs() {
        let tar = fixture_tar();
        let encoded = [
            (ArchiveFormat::Tar, tar.clone()),
            (ArchiveFormat::Tar, gzip(&tar)),
            (ArchiveFormat::TarZstd, zstd::stream::encode_all(tar.as_slice(), 1).unwrap()),
            (ArchiveFormat::TarBzip2, bzip(&tar)),
        ];
        for (format, bytes) in encoded {
            let path = temp_path("tar-decoded");
            std::fs::write(&path, bytes).unwrap();
            for ceiling in [511, 1023, 1535] {
                let mut limits = limits(10);
                limits.tar.max_decoded_bytes = ceiling;
                let cancelled = Arc::new(AtomicBool::new(false));
                let error = inspect_tar(path.to_str().unwrap(), format, limits, Arc::clone(&cancelled)).unwrap_err();
                assert!(error.reason.contains(crate::tar_meter::DECODED_LIMIT), "{error}");
                let error = extract_tar(path.to_str().unwrap(), format, -1, HashMap::new(), Arc::clone(&cancelled), limits.tar).unwrap_err();
                assert!(error.reason.contains(crate::tar_meter::DECODED_LIMIT), "{error}");
                let error = read_tar_entry(path.to_str().unwrap(), format, "absent", 1, cancelled, limits.tar).unwrap_err();
                assert!(error.reason.contains(crate::tar_meter::DECODED_LIMIT), "{error}");
            }
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn every_tar_pass_finishes_physical_eof_for_all_codecs() {
        let canonical = fixture_tar();
        let ceiling = canonical.len() as u64;
        let fixtures = [
            ("zero padding", [canonical.as_slice(), &[0; 513]].concat(), crate::tar_meter::DECODED_LIMIT),
            ("nonzero trailer", [canonical.as_slice(), &[1]].concat(), "archive-header-invalid"),
            ("missing second EOF block", canonical[..canonical.len() - 512].to_vec(), "archive-header-invalid"),
            ("header after one zero block", [canonical[..canonical.len() - 512].as_ref(), &canonical[..512]].concat(), "archive-header-invalid"),
            ("truncated later body", canonical[..1536].to_vec(), "archive-header-invalid"),
        ];
        for (label, tar, code) in fixtures {
            let encoded = [
                (ArchiveFormat::Tar, tar.clone()),
                (ArchiveFormat::Tar, gzip(&tar)),
                (ArchiveFormat::TarZstd, zstd::stream::encode_all(tar.as_slice(), 1).unwrap()),
                (ArchiveFormat::TarBzip2, bzip(&tar)),
            ];
            for (format, bytes) in encoded {
                let path = temp_path("tar-physical-eof");
                std::fs::write(&path, bytes).unwrap();
                let mut limits = limits(10);
                limits.tar.max_decoded_bytes = ceiling;
                let cancelled = Arc::new(AtomicBool::new(false));
                let results = [
                    ("inspect", inspect_tar(path.to_str().unwrap(), format, limits, Arc::clone(&cancelled)).map(|_| ())),
                    ("extract", extract_tar(path.to_str().unwrap(), format, -1, HashMap::new(), Arc::clone(&cancelled), limits.tar)),
                    ("read", read_tar_entry(path.to_str().unwrap(), format, "one.txt", 3, Arc::clone(&cancelled), limits.tar).map(|_| ())),
                ];
                std::fs::remove_file(path).unwrap();
                for (pass, result) in results {
                    let error = result.expect_err(&format!("{pass} accepted {label}"));
                    assert!(error.reason.contains(code), "{pass}: {label}: {error}");
                }
            }
        }
    }

    #[test]
    fn physical_eof_completion_preserves_read_and_plan_errors() {
        let canonical = fixture_tar();
        let path = temp_path("tar-finish-errors");
        std::fs::write(&path, &canonical).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut limits = limits(10);
        limits.tar.max_decoded_bytes = canonical.len() as u64;
        let read = |name, max_bytes, budget| read_tar_entry(
            path.to_str().unwrap(), ArchiveFormat::Tar, name, max_bytes,
            Arc::clone(&cancelled), budget,
        );
        assert_eq!(read("one.txt", 3, limits.tar).unwrap(), b"one");
        assert!(read("absent", 3, limits.tar).unwrap_err().reason.contains("archive entry not found: absent"));
        let mut one_entry = limits.tar;
        one_entry.max_entries = 1;
        assert!(read("one.txt", 3, one_entry).unwrap_err().reason.contains("archive-entry-count-exceeds-limit"));

        assert!(read("one.txt", 2, limits.tar).unwrap_err().reason.contains("archive-entry-extracted-size-exceeds-limit"));
        std::fs::write(&path, [canonical.as_slice(), &[1]].concat()).unwrap();
        // Complete admission now precedes selected-member policy, as in the public API.
        assert!(read("one.txt", 2, limits.tar).unwrap_err().reason.contains("archive-header-invalid"));
        assert!(read("absent", 3, limits.tar).unwrap_err().reason.contains("archive-header-invalid"));
        let plan = HashMap::from([(99, NativeArchivePlanEntry {
            index: 99, path: "absent".to_owned(), kind: "file".to_owned(), size: 0.0, mode: 0o600,
        })]);
        let error = extract_tar(path.to_str().unwrap(), ArchiveFormat::Tar, -1, plan, Arc::clone(&cancelled), limits.tar).unwrap_err();
        assert!(error.reason.contains("archive-header-invalid"), "{error}");

        cancelled.store(true, Ordering::Relaxed);
        assert!(read("one.txt", 3, limits.tar).unwrap_err().reason.contains("archive operation aborted"));
        let error = extract_tar(path.to_str().unwrap(), ArchiveFormat::Tar, -1, HashMap::new(), cancelled, limits.tar).unwrap_err();
        assert!(error.reason.contains("archive operation aborted"), "{error}");
        std::fs::remove_file(path).unwrap();
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
