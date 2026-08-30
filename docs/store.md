---
title: Store
description: "Overview of @openclaw/fs-safe/store: fileStore, fileStoreSync, and jsonStore."
---

# `@openclaw/fs-safe/store`

The `store` subpath bundles two managed wrappers around the same safe-write primitives `root()` uses:

```ts
import {
  ensureJsonDurableQueueDirs,
  fileStore,
  fileStoreSync,
  jsonStore,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
  type FileStore,
  type FileStoreOptions,
  type FileStoreSync,
  type JsonStore,
  type JsonStoreOptions,
} from "@openclaw/fs-safe/store";
```

| Helper | Use it for |
|---|---|
| [`fileStore()`](file-store.md) | Multi-file directories with safe relative paths, size limits, atomic replacement, stream writes, copy-in, and TTL-based pruning. |
| `fileStoreSync()` | Synchronous variant of `fileStore()` for places that genuinely cannot await. |
| [`jsonStore()`](json-store.md) | A single keyed JSON state file with explicit fallback, atomic writes, and optional sidecar locking around read-modify-write updates. |
| Durable JSON queue helpers | Append/load/ack JSON entry files using atomic writes and delivered markers. |
| [Private file-store mode](private-file-store.md) | `fileStore({ private: true })` for credentials, tokens, and per-agent state at `0600` files under `0700` directories. |

`fileStore().json("rel.json")` and `jsonStore({ filePath })` are intentionally separate primitives. Use `fileStore().json(...)` when JSON state lives alongside other files in the same managed directory; use `jsonStore({ filePath })` when you have a single absolute path and want the keyed JSON shape directly.

## Picking a shape

- **Multi-file directory under one root** — reach for `fileStore()`. It exposes `write`, `writeJson`, `writeText`, `writeStream`, `read*`, `open`, `copyIn`, `remove`, and `pruneExpired` against safe relative paths.
- **One JSON state file** — reach for `jsonStore({ filePath })`. Its `update()` and `updateOr()` methods cover the merge-into-defaults and read-modify-write cases.
- **Credentials or tokens** — pass `private: true` to `fileStore()`. Same store shape; writes route through the secret-file atomic path with `0600`/`0700` permissions.
- **Durable work queues** — use the durable JSON queue helpers when each work item is a standalone JSON file and acknowledgement is represented by moving it through a short-lived `.delivered` marker.

## Durable JSON queues

The durable queue helpers are intentionally low-level. They do not decide retry,
dedupe, or recovery policy; they just provide the filesystem mechanics that
several queue implementations otherwise rewrite by hand.

```ts
await ensureJsonDurableQueueDirs({ queueDir, failedDir });

const paths = resolveJsonDurableQueueEntryPaths(queueDir, id);
await writeJsonDurableQueueEntry({
  filePath: paths.jsonPath,
  entry,
  tempPrefix: "queue",
});

const pending = await loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue" });
```

`id` must be a single safe path segment: non-empty, not dot-prefixed, and made
from letters, numbers, `_`, `-`, and `.`. Slashes, backslashes, NUL bytes, `.`,
and `..` are rejected.

Use `ackJsonDurableQueueEntry()` after durable processing succeeds and
`moveJsonDurableQueueEntryToFailed()` when the caller wants to quarantine an
entry for inspection.

Loading serializes consumers for one ID through a sidecar lock, then creates `processingPath` with a no-replace hardlink and retires the source through a recoverable sibling record. Whichever producer generation occupies `.json` at the hardlink operation becomes the claim; a replacement published afterward remains pending. After a crash, `.processing` is retried before that pending replacement. Transfer locks are fail-closed and are never reclaimed automatically, so an operator must remove a proven-stale lock after a hard process crash. Acknowledgement atomically moves `.processing` through the short-lived `.delivered` marker, and existing delivered markers are cleaned during batch loading. `ackJsonDurableQueueEntry()` rejects while `.json` exists without a processing claim: callers that previously paired direct `readJsonDurableQueueEntry()` with acknowledgement must load through `loadJsonDurableQueueEntry()` before processing so acknowledgement is generation-bound.

Queue and failed directory creation fsyncs every newly-created parent edge from the leaf toward the trusted root. Enqueue and migration writes fsync the temp file and parent; claim, acknowledgement, quarantine, delivered-marker cleanup, and retirement transitions fsync every affected directory and propagate real sync failures. A transition may already be visible when a post-mutation sync fails, so retry the same operation to complete its crash-recovery state; quarantine retries with only failed evidence resync that destination before repairing the vanished queue source.

Failed destinations are create-only. Quarantine publishes the claimed file by hardlink, so the queue and failed directories must share a filesystem with hardlink support. If `failed/<id>.json` already exists, quarantine rejects while preserving both that earlier evidence and the current claimed entry instead of overwriting either file. The `read` callback continues to receive the logical `.json` path even though bytes are read and migrations are written through the claimed path.

Queue entry reads verify lossless file identities before opening, on the opened
descriptor, and at the current pathname before reading bytes. POSIX opens are
nonblocking, so a raced FIFO is rejected rather than stalling a consumer. On Windows, an
unknown identity gets one bounded reinspection; persistent ambiguity or a
mismatch rejects with `queue entry changed during read`. Each inspection still
rejects non-files, symlinks, hardlinks, and entries over the byte limit.

## Related pages

- [`fileStore`](file-store.md) — full API for the multi-file store.
- [`jsonStore`](json-store.md) — single-file JSON store with locking.
- [Private file-store mode](private-file-store.md) — credential-shaped variant.
- [JSON files](json.md) — lower-level `readJson` / `writeJson` helpers.
- [Atomic writes](atomic.md) — what `fileStore` and `jsonStore` use under the hood.
