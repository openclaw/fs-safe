import type { StagedFileReceipt } from "./staged-file-types.js";

/** Caller-captured admission evidence, never a same-target ownership heuristic. */
export type StagedSymlinkExpected = Readonly<{
  dev: bigint;
  ino: bigint;
  uid: number;
  gid: number;
  ctimeNs: bigint;
  target: string;
}>;

export type StagedSymlinkReceipt = StagedFileReceipt & Readonly<{ target: string }>;
export type PublishedSymlinkReceipt = Readonly<{
  status: "published";
  staged: StagedSymlinkReceipt;
  basename: string;
  overwrite: false;
}>;
export type StagedSymlinkPublication =
  | Readonly<{ status: "not-published" }>
  | PublishedSymlinkReceipt
  | Readonly<{ status: "indeterminate"; basename: string; overwrite: false }>;
export type StagedSymlinkRemoval = "removed" | "name-absent" | "preserved";
export type StagedSymlinkCleanupReceipt = Readonly<{
  temporaryBasename: string;
  publication: StagedSymlinkPublication;
  status: StagedSymlinkRemoval | "failed" | "not-needed";
  resources: "closed" | "close-failed";
}>;
export type StagedSymlinkFailureDetails = Readonly<{
  phase: "prepare" | "publish" | "remove-published" | "cleanup";
  publication: StagedSymlinkPublication;
  cleanup?: StagedSymlinkCleanupReceipt;
}>;

export interface StagedSymlink extends AsyncDisposable {
  readonly receipt: StagedSymlinkReceipt;
  assertCurrent(): Promise<void>;
  publish(basename: string): Promise<PublishedSymlinkReceipt>;
  /** Check the published name against the still-retained original symlink. */
  assertPublished(): Promise<void>;
  /** Explicit recovery only. Never removes an observed foreign replacement. */
  removePublished(): Promise<StagedSymlinkRemoval>;
  /** Closes the owner; only an unattempted, still-owned stage is removed. */
  cleanup(): Promise<StagedSymlinkCleanupReceipt>;
}
