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
export function admitZipBuffer(input: Uint8Array, limits: ResolvedArchiveExtractLimits): number {
  checkSize(input.byteLength, limits);
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const scan = scanZipDirectory(buffer.length, limits);
  let step = scan.next();
  while (!step.done) {
    const { offset, length } = step.value;
    step = scan.next(buffer.subarray(offset, offset + length));
  }
  return step.value;
}

/** The extraction input is already private and staged; read only bounded metadata. */
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
    let step = scan.next();
    while (!step.done) {
      const { offset, length } = step.value;
      const bytes = Buffer.alloc(length);
      let received = 0;
      while (received < length) {
        deadline.check();
        const count = await new Promise<number>((resolve, reject) => {
          fs.read(opened.fd, bytes, received, length - received, offset + received,
            (error, count) => error ? reject(error) : resolve(count));
        });
        deadline.check();
        if (!count) zipFormat("truncated staged record");
        received += count;
      }
      step = scan.next(bytes);
    }
    return step.value;
  } finally {
    fs.closeSync(opened.fd);
  }
}
