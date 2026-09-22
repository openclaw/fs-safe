import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import { admitZipBuffer } from "./archive-zip-admission.js";
import { loadAdmittedZipArchive, type ZipArchiveWithFiles } from "./archive-zip-loader.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";

export async function loadZipArchiveWithPreflight(
  buffer: Buffer | Uint8Array,
  limits?: ArchiveExtractLimits,
): Promise<ZipArchiveWithFiles> {
  const resolvedLimits = resolveExtractLimits(limits);
  if (buffer.byteLength > resolvedLimits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const entries: ZipDirectoryEntry[] = [];
  admitZipBuffer(buffer, resolvedLimits, entry => { entries.push(entry); });
  return await loadAdmittedZipArchive(buffer, entries);
}
