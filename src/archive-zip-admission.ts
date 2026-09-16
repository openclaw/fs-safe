import fs from "node:fs";
import path from "node:path";
import type { ExtractionDeadline } from "./archive-deadline.js";
import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError, type ResolvedArchiveExtractLimits } from "./archive-limits.js";
import { openRootFile } from "./root-file.js";
import { scanZipDirectory, type ZipDirectoryEntry } from "./archive-zip-directory.js";
import { zipFormat } from "./archive-zip-names.js";

function checkSize(size: number, limits: ResolvedArchiveExtractLimits): void {
  if (size > limits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  if (!Number.isSafeInteger(size) || size < 0) zipFormat("invalid archive size");
}

/** Admit physical records before a decoder can normalize or collapse names. */
export function admitZipBuffer(
  input: Uint8Array, limits: ResolvedArchiveExtractLimits, onEntry?: (entry: ZipDirectoryEntry) => void,
): number {
  checkSize(input.byteLength, limits);
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const scan = scanZipDirectory(buffer.length, limits, onEntry);
  let step = scan.next();
  while (!step.done) {
    const { offset, length } = step.value;
    step = scan.next(buffer.subarray(offset, offset + length));
  }
  return step.value;
}

const METADATA_WINDOW_BYTES = 4096;
const CACHED_READS_PER_YIELD = 32;
type MetadataWindow = { offset: number; bytes: Buffer };

/** The extraction input is private and immutable; read bounded metadata windows. */
export async function admitZipFile(
  archivePath: string, limits: ResolvedArchiveExtractLimits, deadline: ExtractionDeadline,
  onEntry?: (entry: ZipDirectoryEntry) => void,
): Promise<number> {
  deadline.check();
  const opened = await openRootFile({
    absolutePath: archivePath, rootPath: path.dirname(archivePath),
    boundaryLabel: "staged ZIP archive", rejectSymlinks: true, rejectHardlinks: true,
  });
  if (!opened.ok) throw opened.error ?? new Error("cannot open staged ZIP archive");
  try {
    checkSize(opened.stat.size, limits);
    const scan = scanZipDirectory(opened.stat.size, limits, onEntry);
    // Separate windows keep alternating central and local records hot. Never
    // refill a buffer: the scanner can retain its views after cache eviction.
    const windows: MetadataWindow[] = [];
    let cachedReads = 0;
    let step = scan.next();
    while (!step.done) {
      deadline.check();
      const { offset, length } = step.value;
      const cached = windows.findIndex(window => offset >= window.offset &&
        length <= window.bytes.length - (offset - window.offset));
      let bytes: Buffer;
      if (cached !== -1) {
        if (++cachedReads >= CACHED_READS_PER_YIELD) {
          cachedReads = 0;
          await new Promise<void>(resolve => setImmediate(resolve));
          deadline.check();
        }
        const window = windows[cached]!;
        if (cached === 1) windows.reverse();
        bytes = window.bytes.subarray(offset - window.offset, offset - window.offset + length);
      } else {
        const cacheable = length > 0 && length <= METADATA_WINDOW_BYTES;
        const capacity = cacheable ? Math.min(METADATA_WINDOW_BYTES, opened.stat.size - offset) : length;
        const buffer = Buffer.alloc(capacity);
        let received = 0;
        while (received < capacity) {
          deadline.check();
          const count = await new Promise<number>((resolve, reject) => {
            fs.read(opened.fd, buffer, received, capacity - received, offset + received,
              (error, count) => error ? reject(error) : resolve(count));
          });
          cachedReads = 0;
          deadline.check();
          if (!count) {
            if (received < length) zipFormat("truncated staged record");
            break;
          }
          received += count;
        }
        const filled = buffer.subarray(0, received);
        bytes = filled.subarray(0, length);
        if (cacheable) {
          windows.unshift({ offset, bytes: filled });
          if (windows.length > 2) windows.pop();
        }
      }
      step = scan.next(bytes);
    }
    return step.value;
  } finally {
    fs.closeSync(opened.fd);
  }
}
