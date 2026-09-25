import type { Root } from "./root.js";

/** Literal Root-relative names, never globs. A tree includes its entry. */
export type WatchScope = Readonly<{
  path: string;
  kind: "entry" | "tree";
  /** Tree child depth; zero observes only the entry. Default: 32. */
  depth?: number;
}>;
export type WatchEntry = Readonly<{
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
}>;
export type WatchChange = Readonly<{ path: string; type: "content" | "structural" }>;
export type WatchFailure = Readonly<{ operation: "watch" | "scan" | "callback" | "close"; code?: string }>;
export type WatchDirty = Readonly<{
  generation: number;
  scopes: readonly WatchScope[];
  /** Bounded advisory detail; undefined means invalidate every supplied scope. */
  changes?: readonly WatchChange[];
  reason: "event" | "reconcile" | "update" | "overflow";
}>;
export type WatchHealth = Readonly<{
  state: "starting" | "ready" | "reconciling" | "unavailable" | "closing" | "closed";
  generation: number;
  mode: "node" | "poll";
  /** Registered directories, not a portable kernel-watch count. */
  directories: number;
  /** Last completed guarded directory inventory, separate from physical registrations. */
  observedDirectories: number;
  workers: number;
  scannedEntries: number;
  reconciliations: number;
  pendingInvalidations: number;
  error?: unknown;
  failure?: WatchFailure;
}>;
export type WatchOptions = {
  scopes: readonly WatchScope[];
  /** No implicit fallback. Native node mode requires Linux Node.js and verified
   * procfs; other runtimes must explicitly select poll. Default: node. */
  mode?: "node" | "poll";
  /** Guarded metadata reconciliation interval. Default: 30000 (node), 1000 (poll). */
  intervalMs?: number;
  persistent?: boolean;
  maxDirectories?: number;
  maxEntries?: number;
  maxPasses?: number;
  maxPendingPaths?: number;
  /** Synchronous exclusion; excluded directories are not descended into. */
  exclude?: (entry: WatchEntry) => boolean;
  /** Synchronous notifications. Start application async work outside these callbacks. */
  onDirty: (hint: WatchDirty) => void;
  onHealth?: (health: WatchHealth) => void;
  signal?: AbortSignal;
};
export type WatchSubscription = {
  readonly ready: Promise<void>;
  /** Revoke the previous generation immediately; resolve after new admission. */
  update(scopes: readonly WatchScope[]): Promise<void>;
  /** Re-observe independently of hints. Coalesces concurrent requests. */
  reconcile(): Promise<void>;
  health(): WatchHealth;
  /** Terminal/idempotent. Join owned work; reject retirement/cleanup failures,
   * not prior observation failures (which remain in health). */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
export type WatchFunction = (root: Root, options: WatchOptions) => WatchSubscription;
