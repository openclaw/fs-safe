import type { ArchiveKind } from "./archive-kind.js";
import type { ArchiveExtractLimits } from "./archive-limits.js";
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
