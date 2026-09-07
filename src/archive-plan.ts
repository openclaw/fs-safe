import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import {
  createArchiveOutputPathTracker,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import type { ArchiveKind } from "./archive-kind.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  assertArchiveEntryCountWithinLimit,
  assertArchiveEntryPathComponentsWithinLimit,
  createByteBudgetTracker,
  resolveExtractLimits,
} from "./archive-limits.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { resolveArchiveEntryMode, shouldExtractArchiveEntry } from "./archive-policy.js";
import { formatErrorDetail } from "./error-detail.js";

export type ArchiveMemberKind = "file" | "directory" | "symlink" | "hardlink" | "blocked" | "sparse" | "other";
export type ArchivePlanEntry = { path: string; kind: "file" | "directory"; size: number; mode: number };
export type ArchivePlanOptions = Pick<ExtractArchiveOptions,
  "stripComponents" | "limits" | "entryModes" | "entryFilter" | "onFiltered"> & {
  kind: ArchiveKind;
  rootDir?: string;
  escapeLabel?: string;
};

// Inspection and both executors decide over the same admitted identities.
// A destination is optional only for inspection; writers still prove containment.
export function createArchiveEntryPlanner(params: ArchivePlanOptions): (entry: {
  path: string; kind: ArchiveMemberKind; size: number; mode?: number;
}) => ArchivePlanEntry | null {
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
  const limits = resolveExtractLimits(params.limits);
  const budget = createByteBudgetTracker(limits);
  const trackOutputPath = createArchiveOutputPathTracker();
  let entryCount = 0;
  return (entry) => {
    assertArchiveEntryCountWithinLimit(++entryCount, limits);
    validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });
    const canonicalPath = stripArchivePath(entry.path, 0);
    if (!canonicalPath) return null;
    const relPath = stripArchivePath(canonicalPath, strip);
    if (!relPath) return null;
    validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
    assertArchiveEntryPathComponentsWithinLimit(relPath, limits);
    trackOutputPath(relPath, entry.path);
    if (params.rootDir !== undefined) {
      resolveArchiveOutputPath({ rootDir: params.rootDir, relPath, originalPath: entry.path,
        escapeLabel: params.escapeLabel });
    }
    const kind = entry.kind === "file" || entry.kind === "directory" ? entry.kind
      : entry.kind === "symlink" || entry.kind === "hardlink" ? "symlink" : "other";
    if (!shouldExtractArchiveEntry({ filter: params.entryFilter, onFiltered: params.onFiltered,
      entry: { path: canonicalPath, kind, size: entry.size } })) return null;
    if (entry.kind === "sparse") {
      throw new ArchiveFormatError(`GNU sparse archive entry is not supported: ${formatErrorDetail(entry.path)}`);
    }
    if (kind === "symlink" || entry.kind === "blocked") {
      const label = params.kind === "zip" ? "zip" : "tar";
      throw new ArchiveSecurityError("entry-link", `${label} entry is a link: ${formatErrorDetail(entry.path)}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    // Unsupported records remain visible to policy but cannot create outputs.
    if (kind === "other") return null;
    if (kind === "file" || params.kind !== "zip") {
      budget.startEntry();
      budget.addEntrySize(entry.size);
    }
    return { path: relPath, kind, size: entry.size,
      mode: resolveArchiveEntryMode({ kind, archivedMode: entry.mode, policy: params.entryModes }) };
  };
}
