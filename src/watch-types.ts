/** Literal Root-relative names. Trees include their entry; depth defaults to 32 (max 128). */
export type WatchScope = Readonly<{ path: string; kind: "entry" | "tree"; depth?: number }>;
export type WatchEntry = Readonly<{ path: string; kind: "file" | "directory" | "symlink" | "other" }>;
export type WatchChange = Readonly<{ path: string; type: "content" | "structural" }>;
export type WatchInvalidation = Readonly<{
  reason: "event" | "reconcile" | "overflow";
  /** Bounded advisory detail. undefined => invalidate every configured scope. */
  changes?: readonly WatchChange[];
}>;
export type WatchFailure = Readonly<{ operation: "watch" | "scan" | "callback" | "close"; code?: string; error: unknown }>;
export type WatchHealth = Readonly<{
  state: "starting" | "ready" | "reconciling" | "unavailable" | "closed";
  mode: "events" | "poll";
  /** Directories currently observed, for pressure warnings. */
  directories: number;
  failure?: WatchFailure;
}>;
export type WatchOptions = {
  scopes: readonly WatchScope[];
  /** Required. auto selects events when available, otherwise poll. */
  mode: "auto" | "events" | "poll";
  /** Guarded reconciliation interval: events 30000, poll 1000; minimum 20 ms. */
  intervalMs?: number;
  exclude?: (entry: WatchEntry) => boolean;
  maxDirectories?: number;
  maxEntries?: number;
  maxPendingPaths?: number;
  onInvalidate: (invalidation: WatchInvalidation) => void;
  onHealth?: (health: WatchHealth) => void;
  signal?: AbortSignal;
};
export type WatchSubscription = {
  readonly ready: Promise<void>;
  /** Immediately fences the old generation. Superseded calls reject AbortError. */
  setScopes(scopes: readonly WatchScope[]): Promise<void>;
  /** Completes a pass started after this call; concurrent pending requests coalesce. */
  reconcile(): Promise<void>;
  health(): WatchHealth;
  /** Terminal, idempotent, joined; rejects only retirement failures. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
