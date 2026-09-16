import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import { validateArchiveEntryPath } from "./archive-entry.js";

export type ZipArchiveWithFiles = {
  files: Record<string, unknown>;
};

type JsZipConstructor = {
  loadAsync(buffer: Buffer | Uint8Array): Promise<ZipArchiveWithFiles>;
};

/** Internal: the caller has admitted these unchanged bytes and their physical count. */
export async function loadAdmittedZipArchive(
  buffer: Buffer | Uint8Array,
  entryCount: number,
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
  if (names.length !== entryCount) {
    throw new ArchiveSecurityError(
      "entry-path",
      "zip archive contains duplicate or colliding entry names",
    );
  }
  for (const name of names) validateArchiveEntryPath(name);
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
