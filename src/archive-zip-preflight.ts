import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  assertArchiveEntryCountWithinLimit,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";

export type ZipArchiveWithFiles = {
  files: Record<string, unknown>;
};

type JsZipConstructor = {
  loadAsync(buffer: Buffer | Uint8Array): Promise<ZipArchiveWithFiles>;
};

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_MAX_COMMENT_BYTES = 0xffff;
const ZIP64_ENTRY_COUNT_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;
const ZIP_CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_CENTRAL_FILE_HEADER_MIN_BYTES = 46;
const ZIP_CENTRAL_FILE_HEADER_NAME_LENGTH_OFFSET = 28;
const ZIP_CENTRAL_FILE_HEADER_EXTRA_LENGTH_OFFSET = 30;
const ZIP_CENTRAL_FILE_HEADER_COMMENT_LENGTH_OFFSET = 32;
const ZIP_EOCD_TOTAL_ENTRIES_OFFSET = 10;
const ZIP_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 12;
const ZIP_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 16;
const ZIP_EOCD_COMMENT_LENGTH_OFFSET = 20;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const ZIP64_EOCD_OFFSET_OFFSET = 8;
const ZIP64_EOCD_TOTAL_ENTRIES_OFFSET = 32;
const ZIP64_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 40;
const ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 48;

function asBufferView(buffer: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(buffer)) {
    return buffer;
  }
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readSafeUInt64LE(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.byteLength < ZIP_EOCD_MIN_BYTES) {
    return -1;
  }
  const minOffset = Math.max(
    0,
    buffer.byteLength - ZIP_EOCD_MIN_BYTES - ZIP_EOCD_MAX_COMMENT_BYTES,
  );
  for (let offset = buffer.byteLength - ZIP_EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + ZIP_EOCD_COMMENT_LENGTH_OFFSET);
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength === buffer.byteLength) {
      return offset;
    }
  }
  return -1;
}

type ZipCentralDirectoryInfo = {
  declaredEntryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  endOfCentralDirectoryOffset: number;
};

function readZip64CentralDirectoryInfo(
  buffer: Buffer,
  eocdOffset: number,
): ZipCentralDirectoryInfo | null {
  const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_BYTES;
  if (locatorOffset < 0 || buffer.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
    return null;
  }
  const zip64EocdOffset = readSafeUInt64LE(buffer, locatorOffset + ZIP64_EOCD_OFFSET_OFFSET);
  if (
    zip64EocdOffset < 0 ||
    zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET + 8 > buffer.byteLength ||
    buffer.readUInt32LE(zip64EocdOffset) !== ZIP64_EOCD_SIGNATURE
  ) {
    return null;
  }
  return {
    declaredEntryCount: readSafeUInt64LE(buffer, zip64EocdOffset + ZIP64_EOCD_TOTAL_ENTRIES_OFFSET),
    centralDirectorySize: readSafeUInt64LE(
      buffer,
      zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET,
    ),
    centralDirectoryOffset: readSafeUInt64LE(
      buffer,
      zip64EocdOffset + ZIP64_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET,
    ),
    endOfCentralDirectoryOffset: eocdOffset,
  };
}

function readZipCentralDirectoryInfo(buffer: Buffer): ZipCentralDirectoryInfo | null {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    return null;
  }
  const declaredEntryCount = buffer.readUInt16LE(eocdOffset + ZIP_EOCD_TOTAL_ENTRIES_OFFSET);
  const centralDirectorySize = buffer.readUInt32LE(
    eocdOffset + ZIP_EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET,
  );
  const centralDirectoryOffset = buffer.readUInt32LE(
    eocdOffset + ZIP_EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET,
  );
  const usesZip64 =
    declaredEntryCount === ZIP64_ENTRY_COUNT_SENTINEL ||
    centralDirectorySize === ZIP64_UINT32_SENTINEL ||
    centralDirectoryOffset === ZIP64_UINT32_SENTINEL;
  if (usesZip64) {
    return (
      readZip64CentralDirectoryInfo(buffer, eocdOffset) ?? {
        declaredEntryCount,
        centralDirectoryOffset,
        centralDirectorySize,
        endOfCentralDirectoryOffset: eocdOffset,
      }
    );
  }
  return {
    declaredEntryCount,
    centralDirectoryOffset,
    centralDirectorySize,
    endOfCentralDirectoryOffset: eocdOffset,
  };
}

function countZipCentralDirectoryHeaders(
  buffer: Buffer,
  info: ZipCentralDirectoryInfo,
): number | null {
  const start = info.centralDirectoryOffset;
  const declaredEnd = start + info.centralDirectorySize;
  const scanEnd = info.endOfCentralDirectoryOffset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(declaredEnd) ||
    !Number.isSafeInteger(scanEnd) ||
    start < 0 ||
    declaredEnd < start ||
    scanEnd < start ||
    scanEnd > buffer.byteLength
  ) {
    return null;
  }
  let offset = start;
  let count = 0;
  while (offset < scanEnd) {
    if (scanEnd - offset < ZIP_CENTRAL_FILE_HEADER_MIN_BYTES) {
      break;
    }
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER_SIGNATURE) {
      break;
    }
    const nameLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_NAME_LENGTH_OFFSET);
    const extraLength = buffer.readUInt16LE(offset + ZIP_CENTRAL_FILE_HEADER_EXTRA_LENGTH_OFFSET);
    const commentLength = buffer.readUInt16LE(
      offset + ZIP_CENTRAL_FILE_HEADER_COMMENT_LENGTH_OFFSET,
    );
    const nextOffset =
      offset + ZIP_CENTRAL_FILE_HEADER_MIN_BYTES + nameLength + extraLength + commentLength;
    if (nextOffset <= offset || nextOffset > scanEnd) {
      return null;
    }
    count += 1;
    offset = nextOffset;
  }
  return count > 0 || info.declaredEntryCount === 0 ? count : null;
}

export function readZipCentralDirectoryEntryCount(buffer: Buffer | Uint8Array): number | null {
  const view = asBufferView(buffer);
  const info = readZipCentralDirectoryInfo(view);
  if (!info) {
    return null;
  }
  const countedEntryCount = countZipCentralDirectoryHeaders(view, info);
  return countedEntryCount === null
    ? info.declaredEntryCount
    : Math.max(info.declaredEntryCount, countedEntryCount);
}

export async function loadZipArchiveWithPreflight(
  buffer: Buffer | Uint8Array,
  limits?: ArchiveExtractLimits,
): Promise<ZipArchiveWithFiles> {
  const resolvedLimits = resolveExtractLimits(limits);
  if (buffer.byteLength > resolvedLimits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const entryCount = readZipCentralDirectoryEntryCount(buffer);
  if (entryCount !== null) {
    assertArchiveEntryCountWithinLimit(entryCount, resolvedLimits);
  }
  const JSZip = await importOptionalJsZip();
  let archive: ZipArchiveWithFiles;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new ArchiveFormatError(
      `invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (entryCount !== null && Object.keys(archive.files).length !== entryCount) {
    throw new ArchiveSecurityError(
      "entry-path",
      "zip archive contains duplicate or colliding entry names",
    );
  }
  return archive;
}

async function importOptionalJsZip(): Promise<JsZipConstructor> {
  try {
    const module = await import("jszip");
    const candidate: unknown =
      typeof module === "function" ? module : (module as { default?: unknown }).default;
    if (
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      candidate === null ||
      typeof (candidate as { loadAsync?: unknown }).loadAsync !== "function"
    ) {
      throw new Error('Optional archive dependency "jszip" does not expose loadAsync().');
    }
    return candidate as JsZipConstructor;
  } catch (err) {
    throw missingOptionalArchiveDependencyError("jszip", err);
  }
}

function missingOptionalArchiveDependencyError(packageName: "jszip", cause: unknown): Error {
  return new Error(
    `Optional archive dependency "${packageName}" is not installed. Install it to use ZIP archive helpers from @openclaw/fs-safe/archive.`,
    { cause },
  );
}
