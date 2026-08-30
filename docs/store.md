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

Loading claims the current `.json` generation by moving it to the path returned as `processingPath`. A producer can then publish one replacement generation at `.json` without changing the bytes owned by the active consumer. Acknowledgement moves only the claimed generation through the short-lived `.delivered` marker; quarantine likewise prefers the claimed generation and leaves a queued replacement untouched. After a crash, `.processing` is retried before the same ID's `.json` replacement. Existing `.delivered` markers remain completed acknowledgements and are cleaned during batch loading.

Failed destinations are create-only. If `failed/<id>.json` already exists, quarantine rejects while preserving both that earlier evidence and the current claimed entry instead of overwriting either file. The `read` callback continues to receive the logical `.json` path even though bytes are read and migrations are written through the claimed path.

Queue entry reads verify lossless file identities before opening, on the opened
descriptor, and at the current pathname before reading bytes. On Windows, an
unknown identity gets one bounded reinspection; persistent ambiguity or a
mismatch rejects with `queue entry changed during read`. Each inspection still
rejects non-files, symlinks, hardlinks, and entries over the byte limit.

## Related pages

- [`fileStore`](file-store.md) — full API for the multi-file store.
- [`jsonStore`](json-store.md) — single-file JSON store with locking.
- [Private file-store mode](private-file-store.md) — credential-shaped variant.
- [JSON files](json.md) — lower-level `readJson` / `writeJson` helpers.
- [Atomic writes](atomic.md) — what `fileStore` and `jsonStore` use under the hood.
