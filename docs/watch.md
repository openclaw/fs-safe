# Guarded filesystem observation

`@openclaw/fs-safe/watch` observes literal paths under an admitted `Root`.
Notifications are advisory invalidations, not a transaction log, stable content,
or authority to read a reported pathname. Guarded metadata scans through the
original Root determine what may be published. Use the Root again to read data.

```ts
import { root } from "@openclaw/fs-safe/root";
import { watch } from "@openclaw/fs-safe/watch";

const workspace = await root("/trusted/workspace");
const subscription = watch(workspace, {
  mode: "auto",
  scopes: [
    { path: "config.json", kind: "entry" },
    { path: "skills", kind: "tree", depth: 8 },
  ],
  exclude: entry => entry.kind === "directory" && entry.path.endsWith("node_modules"),
  onInvalidate(invalidation) {
    // Schedule application-owned settling/reload work; this callback is synchronous.
    console.log(invalidation.reason, invalidation.changes);
  },
});
await subscription.ready;
await subscription.setScopes([{ path: "skills", kind: "tree" }]);
await subscription.reconcile();
await subscription.close();
```

## Contract

The subpath exports `watch` and the types `WatchScope`, `WatchEntry`,
`WatchChange`, `WatchInvalidation`, `WatchFailure`, `WatchHealth`, `WatchOptions`,
and `WatchSubscription`.

An `entry` scope observes only that entry, including its identity and metadata.
A `tree` also observes descendants to its depth (default 32, maximum 128).
Depth zero observes only the entry. The empty string and `.` select the Root;
trailing separators are accepted and normalized after validation. Scopes are
literal names, never globs or home expansion. Absolute paths, traversal, NULs,
and platform namespace aliases reject. Windows scopes also reject reserved
device components and trailing dots/spaces that Win32 would silently alias. Filesystem identity determines ordinary
case/Unicode aliases; names are not compared by lowercasing.

Symlinks are observed as entries and never followed. A symbolic parent fails
admission: separately admit a caller-trusted link target if needed. Missing
entries and ordinary blocking files can become directories in later scans.
Replacing, renaming, or losing the admitted Root fails observation; it never
silently adopts a new Root. Directory entry scopes ignore child-only mtime/size
changes, but include permission-mode changes to the directory itself.

Each invalidation has `reason: "event" | "reconcile" | "overflow"` and optional
bounded `changes: { path, type: "content" | "structural" }[]`. Missing detail
means invalidate **every configured scope**. Initial admission and every
successful `setScopes` publish one undetailed `reconcile` invalidation. A rename
or identity replacement is structural; metadata changes to the same ordinary
file may be content changes. Neither means the file is settled or readable.
Raw event names remain private: detail comes from guarded scans, prior guarded
snapshots, or explicitly configured targets. Unknown names and overflow lose
detail. Exclusion callbacks are synchronous; excluded directories are not
scanned. Exclusions are a scan policy, not a promise that overflow cannot wake
the application.

## Transport and mode

| Platform/runtime | `auto` | Event transport / limitation |
| --- | --- | --- |
| Node.js on Linux with addon | `events` | One shared Rust thread and inotify instance; a nonrecursive watch per distinct directory inode. |
| Node.js on macOS with addon | `events` | One FSEvents stream per subscription on a shared serial dispatch queue. Pathname activity after a swap remains advisory. |
| Node.js on Windows with addon | `events` | Guarded overlapped ReadDirectoryChangesW anchors on the shared IOCP hub; recursive for tree scopes. |
| Bun / other unsupported runtimes | `poll` | TSFN lifetime and shutdown have not been qualified; `events` rejects. |
| Missing/disabled addon | `poll` | `events` rejects with `FsSafeError("helper-unavailable")`. |

The shared hub sleeps until a filesystem event, command, or callback acknowledgement:
Linux blocks on inotify plus eventfd, Windows on IOCP, and macOS on its command
channel (FSEvents wakes it from the serial dispatch queue). There is no native
polling timer; the independent JS reconciliation interval remains authoritative.

`mode` is required. `poll` never starts or loads the watch hub; guarded scans
may still use the existing addon. Existing `FS_SAFE_NATIVE_MODE=off` and
`require` policies apply: `require` plus an unavailable event backend rejects
`auto` too. Health reports the selected `events` or `poll` mode and failures
from selection have `operation: "watch"`.

Linux installs each watch **before** enumerating children. It opens directories
beneath the Root using the shared guarded native open (openat2, or its checked
openat fallback), checks exact identities, verifies the procfs namespace, and
registers through `/proc/self/fd/N/.`. The final `/.` makes `IN_DONT_FOLLOW` apply
to the directory instead of rejecting the procfs magic symlink. The descriptor
closes immediately: inotify retains the inode reference. Reconciliation replaces
registrations when the directory inventory changes. Queue overflow invalidates
all owners; exhausted watch capacity reports `failure.code: "watch-limit"`.
Nonblocking TSFN batches cannot block the hub on JavaScript, and per-owner
pending detail and queued batches are bounded. The last removal stops and joins
the native thread. No Worker threads, eval programs, or JS `fs.watch` are used.

macOS uses FileEvents, NoDefer and WatchRoot with a 30 ms FSEvents latency.
Absolute hints are reduced lexically against the admitted canonical Root;
outside paths never become detail. Dropped/wrapped streams, RootChanged and
Unmount trigger guarded reconciliation. Pathname hints can reflect activity
after a swap, but the Root is never replaced and names require guarded admission.
Removal synchronously stops, invalidates and releases the stream on its queue.

Windows opens overlapped anchors directly through the existing guarded
handle-relative path with READ/WRITE/DELETE sharing.
Recursive anchors cover tree scopes and deduplicate descendant watches; entry
ancestors use nonrecursive anchors. Completed 64 KiB buffers are copied and the
read re-armed before names are examined. Zero-byte / enumeration-loss completions
invalidate every scope. Cancellation waits for IOCP completion before closing
the handle or freeing its buffer; there are no detached retirement waits.

## Budgets and lifecycle

| Option | Default / bound |
| --- | --- |
| `scopes` | At most 128 literal scopes |
| `intervalMs` | 30000 with events; 1000 with poll; minimum 20 ms |
| `maxDirectories` | 4096 observed directories, including scope ancestors |
| `maxEntries` | 100000 examined entries per pass, including excluded entries |
| `maxPendingPaths` | 256; maximum 4096 |
| Reconciliation | One active pass and one coalesced pending pass; no convergence/pass budget |

Periodic guarded reconciliation runs without needing an event. It catches
missed events and works on filesystems where native hints are incomplete.
Scans are metadata comparisons: content changes preserving all compared
metadata may be missed in polling mode. No mode promises transactional
snapshots, complete history, or hard real-time delivery.

`ready` resolves after the first complete guarded scan establishes the baseline,
even while writes continue. Events mode installs each directory registration
before listing it (FSEvents and recursive RDCW anchors cover the crawl). A changed
registration/listing identity is retried up to three times per directory; further
churn invalidates that subtree. Poll mode starts with its first scan and detects
changes during the crawl on the next comparison. Neither mode waits for two
agreeing scans.

Each later pass compares with the previous snapshot, publishes bounded differences,
and adopts its result as the next snapshot. Vanishing entries, kind changes, and
transient descendant scan errors produce structural invalidations, preserving the
Root identity checks. Events during a pass coalesce into one pending pass; detail
overflow or catching up beyond the 25 ms coalescing window emits `overflow` without
detail. Sustained writes cannot exhaust a pass budget or disable observation.

`reconcile()` resolves after a complete pass that **started after the call**. Calls
waiting for the same future pass coalesce; an earlier in-flight pass cannot satisfy
a new call. It rejects only when observation becomes unavailable or is closed.
`setScopes` fences the old generation immediately and resolves after the new
baseline scan; superseded scope calls reject `AbortError`.
An open subscription keeps the Node event loop alive. `signal` triggers close;
await `close()` or `[Symbol.asyncDispose]()` to join owned work.

`health()` returns `starting`, `ready`, `reconciling`, `unavailable`, or `closed`,
the actual mode, observed `directories`, and optional `{ operation, code, error }`
failure. A running reconciliation reports `reconciling`, then returns to `ready`.
Observation becomes `unavailable` on loss of Root authority (removed, replaced,
or inaccessible), fatal native backend/registration failures such as `watch-limit`,
deterministic size limits (`too-large`, operation `scan`), or callback contract
violations. Invalid scope admission, including symbolic parents, still rejects;
it never grants authority through a link. Transient descendant churn does not
make an admitted subscription unavailable. Callbacks may synchronously retire the owner; returning a thenable from
`onInvalidate`, `onHealth`, or `exclude` rejects observation. Application async
work remains application-owned and is not joined by the subscription.

`close()` is terminal, idempotent, and joined. Observation failures remain in
health but do not make successful retirement reject. Retirement failures do
reject, with a `SuppressedError` retaining an earlier observation failure when
both exist. No new generation or callback can be admitted after close.
