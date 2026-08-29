import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import { admitZipBuffer } from "./archive-zip-admission.js";
import { validateArchiveEntryPath } from "./archive-entry.js";
export { readZipCentralDirectoryEntryCount } from "./archive-zip-count.js";

export type ZipArchiveWithFiles = {
  files: Record<string, unknown>;
};

type JsZipConstructor = {
  loadAsync(buffer: Buffer | Uint8Array): Promise<ZipArchiveWithFiles>;
};

export async function loadZipArchiveWithPreflight(
  buffer: Buffer | Uint8Array,
  limits?: ArchiveExtractLimits,
): Promise<ZipArchiveWithFiles> {
  const resolvedLimits = resolveExtractLimits(limits);
  if (buffer.byteLength > resolvedLimits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const entryCount = admitZipBuffer(buffer, resolvedLimits);
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
  if (Object.keys(archive.files).length !== entryCount) {
    throw new ArchiveSecurityError(
      "entry-path",
      "zip archive contains duplicate or colliding entry names",
    );
  }
  for (const name of Object.keys(archive.files)) validateArchiveEntryPath(name);
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
