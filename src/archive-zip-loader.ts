import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import { stripArchivePath, validateArchiveEntryPath } from "./archive-entry.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";
import { isZipSymlinkEntry, type ZipEntry } from "./archive-zip-entry.js";

export type ZipArchiveWithFiles = {
  files: Record<string, unknown>;
};

type JsZipConstructor = {
  loadAsync(buffer: Buffer | Uint8Array): Promise<ZipArchiveWithFiles>;
};

/** Internal: the caller has admitted these unchanged bytes and their metadata. */
export async function loadAdmittedZipArchive(
  buffer: Buffer | Uint8Array,
  admitted: ZipDirectoryEntry[],
): Promise<ZipArchiveWithFiles> {
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
  const names = Object.keys(archive.files);
  if (names.length !== admitted.length) {
    throw new ArchiveSecurityError(
      "entry-path",
      "zip archive contains duplicate or colliding entry names",
    );
  }
  // Object key order is not central-directory order (numeric names reorder).
  // Use the admitted portable interpretation, including legacy UTF-8 decoding.
  const physicalByPath = new Map(admitted.map(entry => [stripArchivePath(entry.portablePath, 0), entry]));
  for (const name of names) {
    validateArchiveEntryPath(name);
    const key = stripArchivePath(name, 0);
    const physical = physicalByPath.get(key);
    const entry = archive.files[name] as ZipEntry;
    validateArchiveEntryPath(entry.name);
    const kind = isZipSymlinkEntry(entry) ? "symlink" : entry.dir ? "directory" : "file";
    if (!physical || stripArchivePath(entry.name, 0) !== key || kind !== physical.kind) {
      throw new ArchiveFormatError("ZIP decoder disagrees with admitted directory metadata");
    }
    physicalByPath.delete(key);
  }
  if (physicalByPath.size) {
    throw new ArchiveFormatError("ZIP decoder disagrees with admitted directory metadata");
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
