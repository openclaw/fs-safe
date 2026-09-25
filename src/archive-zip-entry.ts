import { ArchiveFormatError } from "./archive-errors.js";
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

const admittedMetadata = new WeakMap<ZipEntry, Readonly<{ kind: ArchiveEntryKind; mode: number | undefined; size: number }>>();

/** Internal: register only after the complete decoder/admission association. */
export function registerAdmittedZipEntry(entry: ZipEntry, physical: ZipDirectoryEntry): void {
  const mode = physical.creatorSystem === 3 ? physical.externalAttributes >>> 16 : undefined;
  admittedMetadata.set(entry, { kind: physical.kind, mode, size: physical.size });
  entry.dir = physical.kind === "directory";
  // Previously unsupported non-UNIX symlinks must also be recognizable to
  // public preflight consumers using JSZip's conventional type inspection.
  entry.unixPermissions = mode ?? (physical.kind === "symlink" ? 0o120000 : null);
  entry.dosPermissions = physical.creatorSystem === 0 ? physical.externalAttributes & 0x3f : null;
}

export function zipEntryIntegrityMetadata(
  entry: ZipEntry,
): { crc32?: number; uncompressedSize?: number } | undefined {
  const data = entry._data;
  if (!data || "then" in data) return undefined;
  return data;
}

export function zipEntryMetadata(entry: ZipEntry) {
  const metadata = admittedMetadata.get(entry);
  if (!metadata) throw new ArchiveFormatError("ZIP decoder disagrees with admitted directory metadata");
  return metadata;
}
