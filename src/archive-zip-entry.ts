import {
  resolveArchiveEntryMode,
  type ArchiveEntryModePolicy,
  type ArchiveEntryKind,
} from "./archive-plan.js";
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

const admittedMetadata = new WeakMap<ZipEntry, { kind: ArchiveEntryKind; mode: number | undefined; size: number }>();

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

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

export function isZipSymlinkEntry(entry: ZipEntry): boolean {
  return zipEntryKind(entry) === "symlink";
}

export function zipEntryKind(entry: ZipEntry): ArchiveEntryKind {
  const metadata = admittedMetadata.get(entry);
  if (metadata) return metadata.kind;
  return typeof entry.unixPermissions === "number" &&
    (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE
    ? "symlink" : entry.dir ? "directory" : "file";
}

export function zipEntryMode(
  entry: ZipEntry,
  policy: ArchiveEntryModePolicy | undefined,
): number {
  const metadata = admittedMetadata.get(entry);
  return resolveArchiveEntryMode({
    kind: entry.dir ? "directory" : "file",
    archivedMode: metadata ? metadata.mode : entry.unixPermissions,
    policy,
  });
}

export function zipEntryDeclaredSize(entry: ZipEntry): number {
  return admittedMetadata.get(entry)?.size ?? Math.max(0, Math.floor(zipEntryIntegrityMetadata(entry)?.uncompressedSize ?? 0));
}
