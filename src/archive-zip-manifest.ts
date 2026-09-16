import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import { stripArchivePath } from "./archive-entry.js";
import type { NativeArchiveEntry } from "./native-binding.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";

/** Associate all native entries with physical admission before exposing any. */
export function validateNativeZipManifest(
  manifest: NativeArchiveEntry[], admitted: ZipDirectoryEntry[],
): void {
  if (manifest.length !== admitted.length) {
    throw new ArchiveSecurityError("entry-path", "zip decoder collapsed entry names");
  }
  for (const [ordinal, entry] of manifest.entries()) {
    const physical = admitted[ordinal];
    // Native indices are physical central-directory ordinals. Legacy name
    // decoding remains native-selected; compare names when admission knows them.
    if (!physical || physical.index !== ordinal || entry.index !== ordinal ||
        entry.size !== physical.size || entry.kind !== physical.kind ||
        (physical.path !== undefined && stripArchivePath(entry.path, 0) !== stripArchivePath(physical.path, 0)) ||
        (physical.creatorSystem === 3 && entry.mode !== physical.externalAttributes >>> 16)) {
      throw new ArchiveFormatError("ZIP decoder disagrees with admitted directory metadata");
    }
  }
}
