import type { ArchiveEntryKind } from "./archive-plan.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";

export type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number | null;
  dosPermissions?: number | null;
  _data?: { crc32?: number; uncompressedSize?: number } | PromiseLike<unknown>;
  nodeStream?: () => NodeJS.ReadableStream;
  async: (type: "nodebuffer") => Promise<Buffer>;
};

export type AdmittedZipEntry = Readonly<{
  entry: ZipEntry;
  name: string;
  kind: ArchiveEntryKind;
  mode: number | undefined;
  size: number;
  crc32: number;
}>;

/** Internal: create only after the complete decoder/admission association. */
export function createAdmittedZipEntry(entry: ZipEntry, name: string, physical: ZipDirectoryEntry): AdmittedZipEntry {
  const mode = physical.creatorSystem === 3 ? physical.externalAttributes >>> 16 : undefined;
  entry.dir = physical.kind === "directory";
  // Previously unsupported non-UNIX symlinks must also be recognizable to
  // public preflight consumers using JSZip's conventional type inspection.
  entry.unixPermissions = mode ?? (physical.kind === "symlink" ? 0o120000 : null);
  entry.dosPermissions = physical.creatorSystem === 0 ? physical.externalAttributes & 0x3f : null;
  return { entry, name, kind: physical.kind, mode, size: physical.size, crc32: physical.crc32 };
}
