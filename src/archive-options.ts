import type { ArchiveKind } from "./archive-kind.js";
import type { ExtractionDeadline } from "./archive-deadline.js";
import type { ArchiveExtractLimits, ResolvedArchiveExtractLimits } from "./archive-limits.js";
import type {
  ArchiveEntryFilter,
  ArchiveEntryModePolicy,
  ArchiveFilteredEntryPolicy,
} from "./archive-policy.js";

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
