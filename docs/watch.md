# Filesystem observation

`@openclaw/fs-safe/watch` observes entries and trees beneath an already admitted
[Root](root.md). Notifications are **advisory dirty hints**, not filesystem
authority, a complete change log, or proof that an external writer has finished.
Use guarded Root operations to read and reconcile application state.

```ts
import { root } from "@openclaw/fs-safe/root";
import { watch } from "@openclaw/fs-safe/watch";

const admitted = await root("/trusted/workspace");
const observer = watch(admitted, {
  mode: "poll", // Portable choice; native "node" mode requires Linux Node.js.
  scopes: [
    { path: "config.json", kind: "entry" },
    { path: "skills", kind: "tree", depth: 8 },
  ],
  onDirty(hint) {
    // Enqueue application-owned work; this callback must be synchronous.
    // hint.changes === undefined means invalidate every hint.scope.
    console.log(hint.generation, hint.changes, hint.scopes);
  },
});
try {
  await observer.ready;
  await observer.reconcile();
  await observer.update([{ path: "skills", kind: "tree", depth: 8 }]);
} finally {
  await observer.close();
}
```

## Authority and links

Scopes are literal Root-relative paths, not globs or home expansions. Each
component is looked up beneath a guarded parent using the filesystem’s own
lookup semantics, rather than unconditional lowercasing or lexical prefix
matching. Case/short-name aliases retain filesystem behavior; case-sensitive
Windows siblings stay distinct. Unmatched native spellings are reconciled with
exact observed identities before any detail is published. A filename
starting with `~` stays literal. Absolute paths, parent traversal and platform
namespace aliases are rejected. Trailing separators are accepted and canonicalized
after validation: `./` selects the Root and `child/` selects `child` (with either
separator on Windows). A structurally similar object is not a Root.
The subscription reuses the Root’s exact admitted identity; it never obtains new
authority from its public pathname fields.

A missing descendant is observable through its existing ancestors **inside that
Root**. The qualified Linux Node backend registers selected ancestor directories
non-recursively through retained directory descriptors. Explicit polling uses
only guarded reconciliation; only relevant descendants are traversed. A missing authority Root
cannot be opened. Admit an appropriate stable ancestor explicitly before constructing the subscription. If the admitted
Root disappears or is replaced, observation fails; it never climbs above the
Root or repins its replacement.

A scope with `kind: "entry"` observes just the named entry, even if it is a
directory. Changes to children are not selected. A tree observes its entry and
descendants up to its depth. This includes the Root entry selected by `path: ""`:
directory mode changes are observed, but child-only size/mtime changes do not
count as changes to the directory entry. Symbolic links are included **as entries**, never
followed. A scope passing through a symbolic parent fails with `symlink`. To
observe a trusted link target, admit that target as a separate Root and observe
the lexical link entry separately. Replacing a Root’s lexical alias does not
change the target authority already admitted by that Root.

## Dirty hints

A notification contains `generation`, the configured `scopes`, `reason`, and
optional bounded `changes`: `{ path, type: "content" | "structural" }`. Paths are
Root-relative advisory names. Raw backend filenames are private scheduling hints:
public detail is admitted by fresh guarded reconciliation, a previous guarded
snapshot (for removals), or the caller’s explicit target. A stale inode watch
moved outside the Root cannot disclose new outside filenames. `content` indicates an ordinary file-change hint
or changed metadata for the same observed file; `structural` covers creation,
removal, replacement, links and uncertain entry kinds. Neither classification
authorizes filesystem access or proves identity.

An ancestor event invalidates the requested descendant rather than exposing
authority outside its scope. Unknown filenames, invalid backend names and queue
overflow discard detail and invalidate **all configured scopes**. Consumers must
not filter whole-scope invalidation away. Initial reconciliation and target
updates also invalidate scopes, so domain caches can rebuild from guarded reads.
The reasons are `event`, `reconcile` and `overflow`; initial admission and
`update(scopes)` both publish a `reconcile` invalidation for the admitted generation.

Both sides of the worker channel have bounded pending detail. The worker allows
one outstanding batch plus one bounded accumulator; the main owner coalesces
within a 25 ms scheduling window, then reconciles before publishing detail. Overflow preserves invalidation, not every event.
There is no unbounded per-event promise queue.

`exclude({ path, kind })` is a synchronous scan predicate. Excluded directories
are not descended into. A backend hint can still name an excluded entry in its
observed parent: hints are conservative, and application filtering is permitted
only for known detail, never for whole-scope loss.

## Readiness, loss and reconciliation

Construction returns immediately. `ready` resolves only after all selected
directory registrations have been accepted and two bounded, guarded metadata
scans agree within the pass budget. There is no successful partially admitted
ready result. Replacement of a physically registered directory retires the old
backend before reacquisition; exact directory identities detect stale registrations.
Each scan revalidates every traversed directory and the pinned Root; logical
inventory is not a physical registration receipt. Polling has no native
registration to reacquire.

**Ready is not continuous coverage.** A worker command reply orders our commands,
not the OS event stream. Directory pins protect registration identity, not a
complete event history or permanent pathname membership. Pathname-only transports
(including Darwin FSEvents) are deferred rather than treating before/after scans
as binding proof. Operation-local listing guards are never retained as
continuous-coverage receipts.

Periodic guarded metadata reconciliation and explicit `reconcile()` supply a
boundary independent of event delivery. Concurrent requests coalesce. Metadata
polling can miss transient states and content changes preserving observed metadata.
A scan is not an atomic snapshot of the tree. Applications needing content
freshness despite silent loss must define their own guarded content-reconciliation
boundary; silence and ready state are not freshness proofs. Write settling, retry
policy, content hashing, parsing and indexing remain application responsibilities.

Health states are `starting`, `ready`, `reconciling`, `unavailable`, `closing` and
`closed`. Failure revokes admission before calling `onHealth`, without waiting
for physical retirement. `health().error` retains the failure and `failure` labels
its `operation` (`watch`, `scan`, `callback` or `close`) and optional error `code`.
For example, watch-creation `ENOSPC` is not a scan-side full-disk error. A failed
subscription is unavailable and must be closed; recovery requires a new
subscription under still-valid caller-admitted authority. No automatic polling
fallback or infinite retry occurs.

## Modes, budgets and lifetime

- `mode: "node"` (default): one owned Node worker per subscription with
  directory-only `fs.watch` registrations. Linux uses non-recursive registrations
  through verified proc-fd paths backed by retained, exact-identity directory pins;
  missing or untrusted procfs fails closed without pathname fallback.
  Native mode is currently supported only by Node.js on Linux; other platforms
  and runtimes, including Bun, fail readiness with `helper-unavailable` and
  `failure.operation: "watch"`, without allocating a worker or silently polling.
  There are no per-file watches. Linux retains one directory descriptor per
  registration until detach/join completes, so descriptor limits remain a real
  admission constraint. A pin prevents adoption of a different symlink target
  during registration; it does not prove continuous path membership after moves.
  Pathname-based Darwin/Windows native transports are deferred until a
  handle-bound route can preserve the same registration authority. Bun 1.4.2
  canonicalizes proc-fd inputs back into pathnames before adding its watcher,
  so it is not a qualified descriptor-bound native route either. Select
  `mode: "poll"` explicitly on these runtimes; do not catch and ignore close
  failures to implement an implicit fallback.
  Default guarded reconciliation interval: 30,000 ms.
- `mode: "poll"`: no watch worker; explicit guarded metadata polling, default
  interval 1,000 ms. It does not hash file content.
- `intervalMs` must be 20 through 2,147,483,647 ms. The next interval starts after
  reconciliation settles; slow scans do not produce a zero-delay timer loop.
- `maxDirectories`: 4,096 by default; bounds scanned inventory even when only
  one native Root registration is owned. `maxEntries`: 100,000 examined entries per
  pass, including explicit component lookups. Native alias verification adds at
  most one guarded entry lookup per bounded pending hint. Both must be positive
  safe integers no larger than 1,000,000.
- `maxPasses`: 4 by default, between 2 and 32. Continuous churn fails with
  `timeout` rather than reporting partial readiness or scanning indefinitely.
- `maxPendingPaths`: 256 by default, between 1 and 4,096. Detail overflow becomes
  whole-scope invalidation. At most 128 configured scopes; tree depth defaults to
  32 and is bounded at 128.
- `persistent: false` unreferences the worker and timers. An `AbortSignal` stops
  admission; await `close()` to observe completion/failures.

`health()` reports the selected mode, generation, directory registrations, worker
count, observed-directory inventory count, last scanned-entry count, reconciliation count and pending invalidation
flag. Polling reports zero physical directory registrations. Directory counts are not portable kernel-watch counts. Repeated whole-tree
metadata scans and one worker per subscription have real CPU/memory costs; this
API makes no performance-win claim. Share logical subscriptions at the application
layer only when appropriate; fs-safe maintains no application-level shared
watcher pool. A runtime may share its native driver infrastructure.

`update(scopes)` synchronously fences the previous generation and resolves after
the new generation has reconciled. Superseded requests reject with `AbortError`.
`close()` is terminal and idempotent: it stops admission synchronously, cancels
timers/scans, joins in-flight work and awaits termination of the owning worker after explicitly detaching its registrations. Bun 1.4.2 has
a process-lifetime native watcher manager: close releases this subscription’s
kernel watches, not the runtime’s shared driver descriptor/thread or peers.
A Node `FSWatcher` close event alone is insufficient: Node schedules that event
on the next tick rather than exposing a native-loop join. No `add()` can reopen
a retired subscription. Close failures remain rejected on repeated calls.

Observation and retirement have separate outcomes. A rejected `ready`,
`reconcile()` or callback is retained in health, but does **not** make a
successfully joined `close()` reject. After successful close, a consumer may
create a new subscription beneath still-valid admitted authority. Never swallow
all close errors to implement retry: failure to detach, terminate/join, or clean
up a scan is a retirement failure, even if observation already failed or the
reported worker count is zero. A failure during generation retirement remains
sticky; no later update can rearm the owner or erase that first failed cleanup.

If both outcomes fail, close rejects a `SuppressedError`-shaped value: `error`
is the retirement failure and `suppressed` retains the observation failure.
Multiple cleanup failures are retained the same way. Health keeps this context
and labels retirement failure as `failure.operation: "close"`; otherwise its
original observation error/provenance survives successful close. The `closed`
state means the owner is terminal and its work has settled, not that retirement
succeeded: await the close promise to distinguish success from failure.

Callbacks must be synchronous; returning a thenable is rejected. Callbacks may
synchronously call `close()` or `update()` without awaiting inside the callback.
Application-owned asynchronous work is not joined by this subscription.

## Native availability and backend selection

The supported Linux Node watch transport does not require the optional Rust addon. Existing guarded
Root/listing operations retain their normal native policy; observation never
rewrites `off` to `auto` or changes `require`. Native-disabled/missing-addon and
Bun polling and native-refusal behavior must be distinguished from qualified
Linux Node native observation and from native-addon package validation.

Rust notify 8.2.0 was evaluated first. Its released Linux and Windows event-loop
implementations discard worker join handles, so dropping the watcher does not
provide the required joined retirement boundary through the existing bridge. It
is deferred rather than patched or silently advertised as joined. The selected
Node worker design still requires platform/runtime and installed-package proof;
source inspection alone does not qualify a backend. Watchman is not installed,
started or required by this API.

See [contributing](contributing.md) for supported package and runtime proof lanes.
The existing bundled-package CI artifact includes the exact root and host-binding
tarballs beside its integrity manifest and consumer proof. Dependent PRs may use
those artifacts in isolated test installs, recording the source commit/tree and
manifest integrity. That is not an npm release: do not commit local tarball paths
or invent a published version to consume an unreleased API.


## Exported types

All observation types are exported from `@openclaw/fs-safe/watch`:

| Type | Contract |
| --- | --- |
| `WatchFunction` | Callable type of `watch(root, options)`. |
| `WatchScope` | Literal relative entry/tree selection and depth. |
| `WatchEntry` | Relative path and kind passed to the synchronous exclusion predicate. |
| `WatchOptions` | Scopes, mode, budgets, callbacks, persistence and cancellation. |
| `WatchSubscription` | Ready promise, target update, reconciliation, health and joined close. |
| `WatchChange` | One bounded relative content/structural hint. |
| `WatchDirty` | Generation, scopes, reason and optional admitted detail; absent detail invalidates scopes. |
| `WatchHealth` | Observation state and resource facts, separate from application freshness. |
| `WatchFailure` | Failure operation and optional code; distinguish watch creation from scan failure. |
