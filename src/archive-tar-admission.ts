import { ArchiveFormatError } from "./archive-errors.js";
import { stripArchivePath, validateArchiveEntryPath } from "./archive-entry.js";
import type { TarEntryInfo } from "./archive-tar.js";
import { readTarHeaderPaths } from "./archive-tar-header.js";

// node-tar's normalFsTypes/ReadEntry switch. All other non-metadata types
// bypass both its filter and entry event; they still belong to our manifest.
const visibleTypes = new Map<number, string>([
  [0, "File"], [0x30, "File"], [0x31, "Link"], [0x32, "SymbolicLink"],
  [0x33, "CharacterDevice"], [0x34, "BlockDevice"], [0x35, "Directory"],
  [0x36, "FIFO"], [0x37, "ContiguousFile"], [0x44, "GNUDumpDir"],
]);

export function rawTarMember(header: Buffer, size: number, effectivePath?: string): TarEntryInfo {
  const { name, prefix } = readTarHeaderPaths(header);
  validateArchiveEntryPath(name);
  validateArchiveEntryPath(prefix);
  const rawPath = prefix ? `${prefix}/${name}` : name;
  validateArchiveEntryPath(rawPath);
  const path = effectivePath ?? rawPath;
  validateArchiveEntryPath(path);
  return { path, size, type: visibleTypes.get(header[156]!) ?? "Unsupported" };
}

export function createTarAdmissionPlan(
  manifest: readonly TarEntryInfo[],
  check: (entry: TarEntryInfo) => boolean,
  strip: number,
): { consume(entry: TarEntryInfo): string | null; finish(): void } {
  const visible: Array<{ entry: TarEntryInfo; output: string | null }> = [];
  for (const entry of manifest) {
    const accepted = check(entry);
    if (entry.type !== "Unsupported") {
      visible.push({ entry, output: accepted ? stripArchivePath(entry.path, strip) : null });
    }
  }
  let index = 0;
  const mismatch = () => new ArchiveFormatError("invalid TAR header: parser disagrees with raw admission");
  return {
    consume(actual) {
      const expected = visible[index++];
      if (!expected || expected.entry.type !== actual.type || expected.entry.size !== actual.size ||
          stripArchivePath(expected.entry.path, 0) !== stripArchivePath(actual.path, 0)) throw mismatch();
      return expected.output;
    },
    finish() { if (index !== visible.length) throw mismatch(); },
  };
}
