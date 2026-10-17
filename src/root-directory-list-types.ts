import type { ExactStatIdentity } from "./stat-observation.js";
import type { BigIntStats } from "node:fs";
import type { DirEntry } from "./types.js";

/** Strings only: cached spellings never replace an observation or its identity fences. */
export type RootDirectoryListingPaths = { directory: string; names: Map<string, string> };

export type RootDirectoryListingResult =
  | { kind: "entry"; entry: DirEntry; identity?: ExactStatIdentity; observation?: BigIntStats }
  | { kind: "limit"; name: string }
  | undefined;

export type RootDirectoryListing = {
  paths: RootDirectoryListingPaths;
  assertCurrent(): Promise<void>;
  next(): Promise<RootDirectoryListingResult>;
  /** Only a complete, already-fenced snapshot can be consumed without awaiting. */
  nextSnapshot?: () => RootDirectoryListingResult;
  [Symbol.asyncDispose](): Promise<void>;
};

export type RootDirectoryListingOptions = {
  order: "sorted" | "filesystem";
  signal?: AbortSignal;
  snapshot: boolean;
  maxNames?: number;
  metadataBatchSize?: number;
  /** Internal watch lane: exact identities and bounded synchronous name reads on Node. */
  exactIdentity?: boolean;
  /** Advisory scans may omit vanished leaves after revalidating their parent. */
  skipVanished?: boolean;
  previousPaths?: RootDirectoryListingPaths;
  /** Internal owner receives cleanup failures, including acquisition rollback. */
  onCleanupFailure?: (error: unknown) => void;
  admitEntry(): boolean;
};
