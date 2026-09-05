import {
  createArchiveOutputPathTracker,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import {
  assertArchiveEntryCountWithinLimit,
  assertArchiveEntryPathComponentsWithinLimit,
  createByteBudgetTracker,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import {
  archiveEntryKindFromTarType,
  shouldExtractArchiveEntry,
  type ArchiveEntryFilter,
  type ArchiveFilteredEntryPolicy,
} from "./archive-policy.js";
import { ArchiveSecurityError } from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";

export type TarEntryInfo = { path: string; type: string; size: number; mode?: number };

const BLOCKED_TAR_ENTRY_TYPES = new Set([
  "SymbolicLink",
  "Link",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
]);

export function createTarEntryPreflightChecker(params: {
  rootDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
  escapeLabel?: string;
  entryFilter?: ArchiveEntryFilter;
  onFiltered?: ArchiveFilteredEntryPolicy;
}): (entry: TarEntryInfo) => boolean {
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
  const limits = resolveExtractLimits(params.limits);
  let entryCount = 0;
  const budget = createByteBudgetTracker(limits);
  const trackOutputPath = createArchiveOutputPathTracker();

  return (entry: TarEntryInfo) => {
    entryCount += 1;
    assertArchiveEntryCountWithinLimit(entryCount, limits);
    validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });

    const canonicalPath = stripArchivePath(entry.path, 0);
    if (!canonicalPath) return false;
    const relPath = stripArchivePath(canonicalPath, strip);
    if (!relPath) {
      return false;
    }
    validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
    assertArchiveEntryPathComponentsWithinLimit(relPath, limits);
    trackOutputPath(relPath, entry.path);
    resolveArchiveOutputPath({
      rootDir: params.rootDir,
      relPath,
      originalPath: entry.path,
      escapeLabel: params.escapeLabel,
    });

    const kind = archiveEntryKindFromTarType(entry.type);
    if (
      !shouldExtractArchiveEntry({
        filter: params.entryFilter,
        onFiltered: params.onFiltered,
        entry: { path: canonicalPath, kind, size: entry.size },
      })
    ) {
      return false;
    }

    if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) {
      throw new ArchiveSecurityError(
        "entry-link",
        `tar entry is a link: ${formatErrorDetail(entry.path)}`,
      );
    }

    // Accepted unsupported records remain omitted, as in the native plan.
    if (kind === "other") return false;

    budget.startEntry();
    budget.addEntrySize(entry.size);
    return true;
  };
}
