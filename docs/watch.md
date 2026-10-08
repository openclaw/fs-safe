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
An admitted native hint can invalidate an entry even when its before/after scan
metadata is identical: the path may have changed and been restored between scans
(ABA), or content may have changed without a distinguishable metadata change.
Structural hints remain conservative in that case.
This does not promise delivery for a differently spelled alias that appears and
disappears entirely between scans: without an observed identity, it cannot be
admitted as the selected path. Observation is not a complete transient history.
Raw event names remain private: detail comes from guarded scans, prior guarded
snapshots, or explicitly configured targets. A non-target name absent from both
snapshots is ignored only when its parent directory has the same device/inode in
both guarded passes. Otherwise the unclassifiable selected hint loses detail.
Hints for excluded or unselected paths are
ignored. Exclusion callbacks are synchronous; excluded directories are recorded
without descent. Bounded exclusion records recognize late deletion hints.
Pending hint pressure folds filenames into directory-level subtree hints, coarsening
toward the Root as needed. Unrelated folds are ignored after guarded alias admission;
relevant or uncertain folds trigger a full guarded pass and publish its snapshot
diff. The hint directory itself is never published without observation. Genuine
backend event loss and snapshot-diff budget exhaustion still invalidate every
scope, including when an excluded subtree caused genuine kernel loss.

On Linux and macOS, an undecodable child name triggers a structural hint for its
containing directory. If that directory's children are selected by a tree scope
with remaining depth, a guarded scan fails closed with `invalid-path` while the
name remains present. An undecodable sibling beside an ancestor or missing-scope
anchor is ignored: it cannot match a validated literal scope component. Raw or
lossily decoded names are never published or used for child I/O. Windows already
fails closed by reconciling after an undecodable UTF-16 notification.

Linux nameless self-events (including directory chmod, rename and deletion) retain
structural detail for the watched directory. Self-events for the Root itself,
kernel queue overflow and malformed transport buffers still lose detail.

## Transport and mode

| Platform/runtime | `auto` | Event transport / limitation |
| --- | --- | --- |
| Node.js on Linux with addon | `events` | One shared Rust thread and inotify instance; a nonrecursive watch per distinct directory inode. |
| Node.js on macOS with addon | `events` | Entry scopes use descriptor-bound kqueue watches; tree scopes share one FSEvents stream per subscription. Pathname activity after a swap remains advisory. |
| Node.js on Windows with addon | `events` | One recursive ReadDirectoryChangesW Root handle per subscription on the shared IOCP hub; the open handle prevents ordinary renames of the Root's ancestors. |
| Bun / other unsupported runtimes | `poll` | TSFN lifetime and shutdown have not been qualified; `events` rejects. |
| Missing/disabled addon | `poll` | `events` rejects with `FsSafeError("helper-unavailable")`. |

The shared hub sleeps until a filesystem event, command, or callback acknowledgement:
Linux blocks on inotify plus eventfd, Windows on IOCP, and macOS on kqueue with a
command wake (FSEvents wakes it from the serial dispatch queue). There is no native
polling timer; the independent JS reconciliation interval remains authoritative.

Linux discards queued events for watches retired by fs-safe, including their
`IN_IGNORED` echoes, without invalidating unrelated subscriptions. A genuinely
unknown descriptor or kernel queue overflow still invalidates every subscription.

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

macOS entry scopes use nonrecursive `EVFILT_VNODE` watches on the admitted parent
and, when present, the entry itself. Parent activity requests a guarded scan
without supplying filenames. The entry descriptor covers content and attribute
changes and is replaced when a guarded scan admits a new identity. Missing paths
use their nearest admitted ancestor. Descriptors are opened without following
symlinks; a symlink entry uses `O_SYMLINK` to observe the link itself. All
non-directory entries are opened nonblocking so a FIFO cannot stall the shared
watch hub. Every
descriptor's device/inode must match the guarded observation. There are at most
two retained descriptors per entry scope (128 scopes maximum), counted in health
`directories`; descriptor exhaustion fails registration with `EMFILE`. Removal
closes these descriptors on the hub before returning. Deep unselected traffic
does not reach an entry-only subscription.

Tree scopes of every depth retain FileEvents, NoDefer and WatchRoot with a 30 ms
FSEvents latency. After guarded admission, streams use only selected tree anchors,
falling back to the nearest admitted ancestor for missing paths. Nested anchors
are deduplicated, with at most 128 paths. The eight shallowest non-overlapping
excluded directories are also passed to `FSEventStreamSetExclusionPaths`.
When the stream paths change, the old stream is stopped, invalidated and released
on its dispatch queue, then its replacement starts before another guarded pass
covers the handover. Native exclusions reduce traffic but cannot eliminate real
FSEvents drops, including during recursive deletion. A shallow tree anchored above
a busy unselected subtree still receives recursive traffic; pending hints fold
under pressure, while genuine FSEvents drops can still overflow.
Absolute hints are reduced lexically against the admitted canonical Root;
outside paths never become detail. Dropped/wrapped streams, RootChanged, Unmount
and notifications naming the Root itself trigger guarded reconciliation without detail.
Pathname hints can reflect activity
after a swap, but the Root is never replaced and names require guarded admission.
Removal synchronously stops, invalidates and releases the stream on its queue.

Windows opens one identity-checked Root handle per subscription with
READ/WRITE/DELETE sharing, backup semantics and overlapped I/O. Each handle
observes the entire subtree; guarded scans filter hints to configured scopes.
No descendant watch handles are retained, so directories inside the Root can be
renamed while watching, including directories containing selected scopes.
Completed buffers are copied and the
read re-armed before names are examined. Zero-byte / enumeration-loss completions
invalidate every scope. Buffers are 1 MiB on confirmed local volumes, and 64 KiB
on network/UNC or unclassified volumes. Cancellation waits for IOCP completion before closing
the handle or freeing its buffer; there are no detached retirement waits.

On Windows, an open file handle—including fs-safe's pinned reads, editors, and
antivirus—blocks renaming that file's ancestor directories, even with delete
sharing. The watch backend retains only the Root's `ReadDirectoryChangesW` handle,
which permits renames beneath the Root. Callers renaming directories concurrently
with reads should use bounded retries, as Windows tools do.

Windows prevents ordinary renames of the Root's own ancestors while its directory
handle is open, even with DELETE sharing. Use `mode: "poll"` when callers must not
retain that handle. Renaming or replacing the Root still fails guarded observation;
the subscription never adopts another location. Subscriptions have independent
handles and delivery queues, and closing one does not retire another's observation.

## Budgets and lifecycle

| Option | Default / bound |
| --- | --- |
| `scopes` | At most 128 literal scopes |
| `persistent` | `true`; `false` lets Node exit with the subscription still open |
| `intervalMs` | 30000 with events; 1000 with poll; minimum 20 ms |
| `pollIntervalMs` | Optional polling override; minimum 20 ms, maximum 2147483647 ms (same as `intervalMs`) |
| `maxDirectories` | 4096 observed directories, including scope ancestors |
| `maxEntries` | 100000 examined entries per pass, including excluded entries |
| `maxPendingPaths` | 256; maximum 4096 |
| Reconciliation | One active pass and one coalesced pending pass; no convergence/pass budget |

Periodic guarded reconciliation runs without needing an event. It catches
missed events and works on filesystems where native hints are incomplete.
Hint validation, scope relevance, and spelling-alias admission share the internal
hint module. Bounded change merging preserves structural precedence and insertion
order; nameless children require remaining tree depth, while folded subtrees also
cover ancestors of selected scopes.
Detailed native batches first pass guarded scope and spelling-alias admission;
proven unrelated activity does not schedule a scan. Relevant entry hints refresh
the entry scopes, while tree hints refresh the affected directory and its identity
chain, retaining unchanged sibling subtrees. Namespace changes, coarse directory
hints, vanished or hard-linked leaves, changed topology, uncertain identities,
backend loss, and batches without filenames still receive a full guarded pass.
`reconcile()`, initial admission, and scope replacement always reconcile every scope.
The periodic timer is independent of event traffic, so frequent hints cannot defer
the full missed-event check. Repeated passes reuse bounded pathname strings, never
cached metadata or filesystem authority.
When polling is selected, the interval is `pollIntervalMs`, then `intervalMs`,
then 1000 ms, in that order. This applies to explicit `mode: "poll"`, `auto`
selecting polling, and `auto` falling back after an unsupported event backend.
`pollIntervalMs` does not change the events reconciliation interval, which
remains `intervalMs` or 30000 ms. For example, `mode: "auto", pollIntervalMs: 25`
uses 25 ms polling when needed and retains the 30-second events reconciliation.
Scans are metadata comparisons: content changes preserving all compared
metadata may be missed in polling mode. No mode promises transactional
snapshots, complete history, or hard real-time delivery.
On Node.js, directory name reads avoid a thread-pool round trip per entry. Scans yield to
the event loop between bounded groups of at most 32 names so cancellation and
other work can progress; every entry still receives the same identity checks
and entry-budget admission before its metadata is read.
Bun and Deno retain asynchronous name reads.

`ready` resolves after the first complete guarded scan establishes the baseline,
even while writes continue. Events mode installs each directory registration
before listing it (FSEvents and recursive RDCW anchors cover the crawl). A changed
registration/listing identity is retried up to three times per directory; further
churn invalidates that subtree. Poll mode starts with its first scan and detects
changes during the crawl on the next comparison. Neither mode waits for two
agreeing scans.
`ready` and `reconcile()` do not drain the operating system's event queue.
For example, FSEvents can deliver coalesced setup creation activity after `ready`,
even with its stream starting at the current event ID. Consumers must tolerate
these advisory invalidations; tests measuring a quiet interval should first
observe a selected sentinel edit and drain its trailing events.

Each later pass compares with the previous snapshot, publishes bounded differences,
and adopts its result as the next snapshot. Vanishing entries, kind changes, and
transient descendant scan errors produce structural invalidations, preserving the
Root identity checks. Events during a pass coalesce into one pending pass and
retain bounded detail regardless of how long the scan takes. The 25 ms hint
coalescing window does not impose a scan deadline. A full native callback queue
retains its bounded pending batch for retry. Pending native and JavaScript hint queues degrade to coarse subtree hints when
full. Genuine backend loss, exhausted snapshot-diff capacity, or an unclassifiable
selected hint emits `overflow` without detail. Sustained writes cannot exhaust a pass budget or disable observation.

`reconcile()` resolves after a complete pass that **started after the call**. Calls
waiting for the same future pass coalesce; an earlier in-flight pass cannot satisfy
a new call. It rejects only when observation becomes unavailable or is closed.
`setScopes` fences the old generation immediately and resolves after the new
baseline scan; superseded scope calls reject `AbortError`.
By default, an open subscription keeps the Node event loop alive, matching
`fs.watch`. Set `persistent: false` for caches used by one-shot commands:
the subscription's timers and native delivery handle do not keep Node alive,
including during startup or reconciliation. Invalidations still arrive while
other work keeps the process alive. Persistent and non-persistent subscriptions
have independent lifetimes; closing the last persistent one lets Node exit.
Native environment cleanup retires any remaining event registrations and joins
the hub at exit. `signal` triggers close, including when a caller's abort
listener stops event propagation;
await `close()` or `[Symbol.asyncDispose]()` to join owned work.

`health()` returns `starting`, `ready`, `reconciling`, `unavailable`, or `closed`,
the actual mode, observed `directories`, and optional `{ operation, code, error }`
failure. A running reconciliation reports `reconciling`, then returns to `ready`.
Observation becomes `unavailable` on loss of Root authority (removed, replaced,
or inaccessible), fatal native backend/registration failures such as `watch-limit`,
deterministic size limits (`too-large`, operation `scan`), or callback contract
violations. Invalid scope admission, including symbolic parents, still rejects;
it never grants authority through a link. Transient descendant churn does not
make an admitted subscription unavailable. Callbacks may synchronously retire
the owner. Returning a thenable or a synchronous or asynchronous generator object
from `onInvalidate`, `onHealth`, or `exclude` rejects observation without advancing
generators. Application async
work remains application-owned and is not joined by the subscription.

`close()` is terminal, idempotent, and joined. Observation failures remain in
health but do not make successful retirement reject. Retirement failures do
reject, with a `SuppressedError` retaining an earlier observation failure when
both exist. No new generation or callback can be admitted after close.

The stress harness also provides `node scripts/watch-stress.mjs --scenario soak-short`,
a two-minute lifecycle and collected-memory smoke. It is separate from the
full one-hour `soak` scenario and its stronger memory-growth qualification.

## Seeded consumer-cache stress test

After building the package and host binding, run the model against real temporary
Roots in both modes:

```sh
node scripts/watch-stress/model-runner.mjs --seeds 2000 --mode both --output watch-model-results.json
```

Each seed generates file and directory edits, renames, replacements, deep trees,
symlink retargets, bursts, scope changes, and subscription retirement. A consumer
queues refreshes only from `onInvalidate`; checkpoints drain those requests after
quiescence and `reconcile()`, then compare its cache with a guarded Root walk and
an independent mutation model. Native hints never authorize consumer reads.

`--seed`, `--steps`, `--settle` (milliseconds), and `--concurrency` control a run.
Failures are shrunk by fast-check and saved beside the report as `.<mode>-<seed>.failure.json`;
replay one with `--replay <failure.json>`. Event mode requires a working native
binding and never silently falls back to polling. The small
`test/watch-model.test.ts` corpus runs in ordinary CI; native-event cases also run
when `FS_SAFE_TEST_WATCH_EVENTS=1`. Keep fixtures on normal `os.tmpdir()` storage.

The nightly watch-stress workflow includes 500 seeds per mode with the finite
state corpus on all five runners. Add `--transitions` to exercise that corpus
before each random sequence in a local run.
It varies `maxPendingPaths` from 2 through 8, creates missing tree descendants
beside concurrent sibling churn, uses filesystem-proven case and Unicode aliases,
and covers atomic-save names, excluded subtrees, Linux undecodable siblings,
directory chmod/rename/deletion, scope replacement, and subscription retirement.
A separate quiet subscription must remain unaffected. The checker records genuine
backend loss and rejects overflow without that loss or a selected diff exceeding
the configured budget. Each checkpoint permits at most four guarded passes and
refreshes the consumer cache only in response to invalidation.
Volumes without Unicode-normalization aliases also receive a distinct spelling
beside the missing target. On Linux a selected undecodable child must fail its
owner closed with `invalid-path` while the other subscription stays healthy.

```sh
node scripts/watch-stress/model-runner.mjs --transitions --seeds 500 --mode both --output watch-transition-results.json
```

For transport diagnosis, add `--native-only`: event-mode checkpoints then wait up
to 400 intervals of 25 ms without calling `reconcile()`. This stronger diagnostic
depends on native event delivery; it is separate from the periodic-reconciliation
guarantee and must not turn an unavailable transport into a passing run. Transition
failures retain their seed and mode in the report; replay them with `--seed N
--seeds 1 --mode events --transitions` and the same diagnostic options.
