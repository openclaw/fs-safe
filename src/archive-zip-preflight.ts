import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import { admitZipBuffer } from "./archive-zip-admission.js";
import { loadAdmittedZipArchive, type ZipArchiveWithFiles } from "./archive-zip-loader.js";
export { readZipCentralDirectoryEntryCount } from "./archive-zip-count.js";
export type { ZipArchiveWithFiles } from "./archive-zip-loader.js";

export async function loadZipArchiveWithPreflight(
  buffer: Buffer | Uint8Array,
  limits?: ArchiveExtractLimits,
): Promise<ZipArchiveWithFiles> {
  const resolvedLimits = resolveExtractLimits(limits);
  if (buffer.byteLength > resolvedLimits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const entryCount = admitZipBuffer(buffer, resolvedLimits);
  return await loadAdmittedZipArchive(buffer, entryCount);
}
