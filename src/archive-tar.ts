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

export function readTarEntryInfo(entry: unknown): TarEntryInfo {
  const p =
    typeof entry === "object" && entry !== null && "path" in entry
      ? String((entry as { path: unknown }).path)
      : "";
  const t =
    typeof entry === "object" && entry !== null && "type" in entry
      ? String((entry as { type: unknown }).type)
      : "";
  const s =
    typeof entry === "object" &&
    entry !== null &&
    "size" in entry &&
    typeof (entry as { size?: unknown }).size === "number" &&
    Number.isFinite((entry as { size: number }).size)
      ? Math.max(0, Math.floor((entry as { size: number }).size))
      : 0;
  const mode =
    typeof entry === "object" &&
    entry !== null &&
    "mode" in entry &&
    typeof (entry as { mode?: unknown }).mode === "number"
      ? (entry as { mode: number }).mode
      : undefined;
  return { path: p, type: t, size: s, mode };
}

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

    const relPath = stripArchivePath(entry.path, strip);
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
        entry: { path: entry.path, kind, size: entry.size },
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

    budget.addEntrySize(entry.size);
    return true;
  };
}
