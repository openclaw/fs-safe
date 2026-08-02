import {
  resolveArchiveEntryMode,
  type ArchiveEntryModePolicy,
} from "./archive-policy.js";

export type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number;
  _data?: { crc32?: number; uncompressedSize?: number };
  nodeStream?: () => NodeJS.ReadableStream;
  async: (type: "nodebuffer") => Promise<Buffer>;
};

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

export function isZipSymlinkEntry(entry: ZipEntry): boolean {
  return (
    typeof entry.unixPermissions === "number" &&
    (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE
  );
}

export function zipEntryMode(
  entry: ZipEntry,
  policy: ArchiveEntryModePolicy | undefined,
): number {
  return resolveArchiveEntryMode({
    kind: entry.dir ? "directory" : "file",
    archivedMode: entry.unixPermissions,
    policy,
  });
}

export function zipEntryDeclaredSize(entry: ZipEntry): number {
  return Math.max(0, Math.floor(entry._data?.uncompressedSize ?? 0));
}
