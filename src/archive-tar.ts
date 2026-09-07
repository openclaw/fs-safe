import type { ArchiveExtractLimits } from "./archive-limits.js";
import {
  createArchiveEntryPlanner,
  type ArchivePlanEntry,
  type ArchivePlanOptions,
} from "./archive-plan.js";
import {
  archiveEntryKindFromTarType,
  type ArchiveEntryFilter,
  type ArchiveFilteredEntryPolicy,
} from "./archive-policy.js";

export type TarEntryInfo = { path: string; type: string; size: number; mode?: number };

const BLOCKED_TAR_ENTRY_TYPES = new Set([
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
]);

export function createTarEntryPlanner(params: Omit<ArchivePlanOptions, "kind">):
  (entry: TarEntryInfo) => ArchivePlanEntry | null {
  const plan = createArchiveEntryPlanner({ ...params, kind: "tar" });
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
