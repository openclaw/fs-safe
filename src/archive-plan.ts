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
  type ResolvedArchiveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import { formatErrorDetail } from "./error-detail.js";
import type { ExtractionDeadline } from "./archive-deadline.js";

export type ArchiveMemberKind = "file" | "directory" | "symlink" | "hardlink" | "blocked" | "sparse" | "other";
export type ArchivePlanEntry = { path: string; kind: "file" | "directory"; size: number; mode: number };
export type ArchivePlanOptions = Pick<ExtractArchiveOptions,
  "stripComponents" | "limits" | "entryModes" | "entryFilter" | "onFiltered"> & {
  rootDir?: string;
  escapeLabel?: string;
};

// Portable ZIP selects each entry immediately before streaming its payload;
// manifest-backed routes add declared-byte admission through the planner below.
export function createArchiveEntrySelector(params: ArchivePlanOptions): {
  limits: ResolvedArchiveExtractLimits;
  select(entry: { path: string; kind: ArchiveEntryKind; size: number }): string | null;
} {
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
  const limits = resolveExtractLimits(params.limits);
  const trackOutputPath = createArchiveOutputPathTracker();
  let entryCount = 0;
  return { limits, select(entry) {
    assertArchiveEntryCountWithinLimit(++entryCount, limits);
    validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });
    const canonicalPath = stripArchivePath(entry.path, 0);
    if (!canonicalPath) return null;
    const relPath = strip === 0 ? canonicalPath : stripArchivePath(canonicalPath, strip);
    if (!relPath) return null;
    validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
    assertArchiveEntryPathComponentsWithinLimit(relPath, limits);
    trackOutputPath(relPath, entry.path);
    if (params.rootDir !== undefined) {
      resolveArchiveOutputPath({ rootDir: params.rootDir, relPath, originalPath: entry.path,
        escapeLabel: params.escapeLabel });
    }
    if (!shouldExtractArchiveEntry({ filter: params.entryFilter, onFiltered: params.onFiltered,
      entry: { path: canonicalPath, kind: entry.kind, size: entry.size } })) return null;
    return relPath;
  } };
}

// A destination is optional only for inspection; writers still prove containment.
export function createArchiveEntryPlanner(params: ArchivePlanOptions, archiveKind: ArchiveKind): (entry: {
  path: string; kind: ArchiveMemberKind; size: number; mode?: number;
}) => ArchivePlanEntry | null {
  const { select, limits } = createArchiveEntrySelector(params);
  const budget = createByteBudgetTracker(limits);
  return (entry) => {
    const kind = entry.kind === "file" || entry.kind === "directory" ? entry.kind
      : entry.kind === "symlink" || entry.kind === "hardlink" ? "symlink" : "other";
    const relPath = select({ path: entry.path, kind, size: entry.size });
    if (relPath === null) return null;
    if (entry.kind === "sparse") {
      throw new ArchiveFormatError(`GNU sparse archive entry is not supported: ${formatErrorDetail(entry.path)}`);
    }
    if (kind === "symlink" || entry.kind === "blocked") {
      const label = archiveKind === "zip" ? "zip" : "tar";
      throw new ArchiveSecurityError("entry-link", `${label} entry is a link: ${formatErrorDetail(entry.path)}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    // Unsupported records remain visible to policy but cannot create outputs.
    if (kind === "other") return null;
    if (kind === "file" || archiveKind !== "zip") {
      budget.startEntry();
      budget.addEntrySize(entry.size);
    }
    return { path: relPath, kind, size: entry.size,
      mode: resolveArchiveEntryMode({ kind, archivedMode: entry.mode, policy: params.entryModes }) };
  };
}
export type ArchiveEntryKind = "file" | "directory" | "symlink" | "other";
export type ArchiveEntryModePolicy = "clamp" | "preserve";
export type ArchiveFilteredEntryPolicy = "reject-archive" | "skip-entry";
export type ArchiveEntryFilter = (entry: {
  /** Validated canonical archive path before stripping: / separators, no empty or . components. */
  path: string;
  kind: ArchiveEntryKind;
  size: number;
}) => "extract" | "skip";

export function archiveEntryKindFromTarType(type: string): ArchiveEntryKind {
  if (type === "Directory" || type === "GNUDumpDir") return "directory";
  if (type === "File" || type === "OldFile" || type === "ContiguousFile") return "file";
  if (type === "SymbolicLink" || type === "Link") return "symlink";
  return "other";
}

export function resolveArchiveEntryMode(params: {
  kind: "file" | "directory";
  archivedMode?: number | null;
  policy?: ArchiveEntryModePolicy;
}): number {
  const archivedMode = (params.archivedMode ?? 0) & 0o777;
  if (params.policy === "preserve") {
    return params.archivedMode == null ? (params.kind === "directory" ? 0o755 : 0o644) : archivedMode;
  }
  if (params.kind === "directory") {
    return 0o755;
  }
  return archivedMode & 0o100 ? 0o755 : 0o644;
}

export function resolveArchiveFilteredEntryPolicy(
  value: unknown,
): ArchiveFilteredEntryPolicy {
  if (value === undefined || value === "reject-archive") return "reject-archive";
  if (value === "skip-entry") return "skip-entry";
  throw new RangeError(
    'archive onFiltered must be "reject-archive" or "skip-entry"',
  );
}

export function shouldExtractArchiveEntry(params: {
  filter?: ArchiveEntryFilter;
  onFiltered?: ArchiveFilteredEntryPolicy;
  entry: Parameters<ArchiveEntryFilter>[0];
}): boolean {
  const onFiltered = resolveArchiveFilteredEntryPolicy(params.onFiltered);
  if (!params.filter || params.filter(params.entry) === "extract") {
    return true;
  }
  if (onFiltered === "reject-archive") {
    throw new ArchiveSecurityError(
      "entry-filtered",
      `archive entry rejected by filter: ${formatErrorDetail(params.entry.path)}`,
    );
  }
  return false;
}
export type TarEntryInfo = { path: string; type: string; size: number; mode?: number };

const BLOCKED_TAR_ENTRY_TYPES = new Set([
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
]);

export function createTarEntryPlanner(params: ArchivePlanOptions):
  (entry: TarEntryInfo) => ArchivePlanEntry | null {
  // Preserve inherited/getter-backed public options and per-entry policy reads.
  const plan = createArchiveEntryPlanner(params, "tar");
  return (entry) => {
    const kind = BLOCKED_TAR_ENTRY_TYPES.has(entry.type) ? "blocked" : archiveEntryKindFromTarType(entry.type);
    // The public checker accepts structural entry objects, including class getters.
    return plan({ path: entry.path, kind, size: entry.size, mode: entry.mode });
  };
}

export function createTarEntryPreflightChecker(params: {
  rootDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
  escapeLabel?: string;
  entryFilter?: ArchiveEntryFilter;
  onFiltered?: ArchiveFilteredEntryPolicy;
}): (entry: TarEntryInfo) => boolean {
  const plan = createTarEntryPlanner(params);
  return (entry) => plan(entry) !== null;
}
export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ExtractArchiveOptions = {
  archivePath: string;
  destDir: string;
  timeoutMs: number;
  /** Sync published files and directories before returning. Defaults to false. */
  durable?: boolean;
  kind?: ArchiveKind;
  stripComponents?: number;
  tarGzip?: boolean;
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;
  entryModes?: ArchiveEntryModePolicy;
  /** Remove these rwx bits from final entry modes. Defaults to zero. */
  entryUmask?: number;
  entryFilter?: ArchiveEntryFilter;
  onFiltered?: ArchiveFilteredEntryPolicy;
};

/** Private executors receive owned options and an already-staged archive path. */
export type StagedArchiveExtractOptions = Pick<ExtractArchiveOptions,
  "archivePath" | "destDir" | "durable" | "stripComponents" | "entryModes" |
  "entryUmask" | "entryFilter" | "onFiltered"> & {
  limits: ResolvedArchiveExtractLimits;
  deadline: ExtractionDeadline;
};
