# File lock

`acquireFileLock()` and `withFileLock()` provide a cross-process file lock with retry and process-exit cleanup. The lock is implemented as a sidecar file (e.g. `state.json` ↔ `state.json.lock`) — only one acquirer can create the sidecar with `O_CREAT | O_EXCL` at a time.

On Windows, both the target and an explicitly supplied `lockPath` reject NTFS
alternate-stream and directory-index namespace spellings before parent creation,
in-process reentrant lookup, or sidecar access. Rooted drive paths retain their
normal meaning, and ordinary colon-bearing POSIX paths remain valid.

JavaScript raw-sidecar creation passes mode `0o600` to that exclusive open. On POSIX, the process umask may further restrict the new file but cannot add group or other access. No pathname `chmod` fallback is used.

Root-backed lock records and reclaim guards also claim their final name
exclusively, including with the native backend. The native path retains the
admitted parent descriptor and removes incomplete claims only while their exact
identity remains owned. Ordinary Root creates still stage privately; lock records
use this internal exclusive-create path so racing contenders can retry without
an ambiguous rename outcome.

```ts
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";

const handle = await acquireFileLock("/var/lib/app/state.json", {
  managerKey: "snapshot",
  staleMs: 5 * 60_000,
  payload: async () => ({ pid: process.pid, host: os.hostname() }),
});
try {
  // ...exclusive work on /var/lib/app/state.json...
} finally {
  await handle.release();
}
```

## Why sidecar?

The lock file sits next to the protected resource. If a process crashes mid-lock, the next acquirer notices the held entry, inspects its payload (PID, host, acquired-at timestamp), and decides — via `shouldReclaim` (defaulting to "is the lock older than `staleMs`?") — whether it should keep waiting or fail.

On natural event-loop shutdown, a globally deduplicated `process.on("beforeExit")` handler attempts asynchronous cleanup of held Root-backed locks through their retained Root capability and ownership receipt. The synchronous `process.on("exit")` handler provides last-chance cleanup for raw locks and raw-path reclaim guards. Changed sidecars and failed Root cleanup remain in place; cleanup does not keep retrying during shutdown unless another acquisition re-arms it. Locks acquired with `retainOnExit: true` are exempt from both handlers: their sidecar stays in place after exit and is governed only by the caller's own stale policy. Because exit handlers are globally deduplicated across package copies, `retainOnExit` fails closed with `helper-unavailable` if an older copy that cannot honor it registered the handlers first.

Asynchronous Root-backed stale recovery uses a regular file at the
`.reclaim` name, created, verified, and removed through that Root. Its ownership
token and exact bytes are checked after awaited decisions and before stale
removal; Root mutation policies also apply to the guard. Raw and synchronous
Root reclaimers use directories and recognize these files as occupied guards.
Each asynchronous attempt owns its guard directly, outside process-exit cleanup,
so `beforeExit` cannot release an exclusion still needed by an unsettled attempt.
Normal completion removes it through the Root. Interrupted creation, revoked
cleanup authority, identity changes, or process exit can leave the guard in
place; recover it only after an application-owned liveness check proves the
attempt has ended. There is no raw-path cleanup fallback. These token/byte
checks retain the sidecar protocol's cooperative, non-atomic removal boundary.
The final guard check follows the last sidecar snapshot and parser call, before
removal. Parsers can run before guard ownership is established or verified;
invocation is not mutation authority. A failing final parser keeps its error
even if guard ownership has also changed.
`manager.reset()` invalidates admission bookkeeping but preserves a pending
Root guard; let its original attempt settle before retrying that guarded path.

Always release locks in a `finally` block. Application-managed graceful shutdown can await `release()` or `manager.drain()` before terminating. Explicit `process.exit()`, uncaught failures, crashes, default signal handling, and fatal termination (including `SIGKILL`) do not reliably run asynchronous Root cleanup and may leave sidecars. Recover only after an application-owned liveness policy proves the holder cannot still be writing.

Exit cleanup tolerates shared managers created by older package copies that lack reclaim-guard state, and continues through later manager domains. Handler ownership remains first-registration-wins: loading an updated copy does not replace an older copy's registered handler. First registration is committed only after Node accepts the listener; synchronous `newListener` reentry fails closed and a thrown registration rolls back so a later acquisition can retry. Restart with the updated copy registering first to obtain the fix. After building, `node scripts/legacy-lock-exit-proof.mjs` checks clean exit, removal of legacy and modern raw locks, and preservation of a retained lock using synthetic temporary files.

Each new sidecar also carries an internal random ownership token encoded as JSON trailing whitespace. `JSON.parse()` and every payload callback still see exactly the caller-provided object. Only the process that successfully created the sidecar keeps that token as release authority; merely reading token-shaped bytes from disk does not enable this mode. Release compares the in-memory token and exact serialized bytes, and requires the pathname to remain a regular file, instead of requiring an opened descriptor and pathname lookup to report the same inode identity. This preserves ownership checks on filesystems such as Docker Desktop VirtioFS where those two views can legitimately differ. Sidecars created by older releases have no token and retain the legacy identity-plus-content check. If Windows reports a zero device or inode for either identity observation, that check is inconclusive and removal is skipped.

The raw sidecar bytes are not a canonical JSON representation: tools that trim or rewrite the trailing whitespace invalidate the ownership token, so release leaves the changed sidecar in place and fails closed. The token distinguishes cooperating acquisitions; it is not a secret and does not make pathname compare-and-remove atomic against a hostile process that can replace files outside the lock protocol.

`release()` propagates an I/O failure that prevents deletion of an unchanged, owned sidecar; it never reports successful cleanup while leaving that lock behind. The handle and manager retain the exact cleanup receipt after a failure, so the same handle can retry `release()` and `manager.drain()` can retry retained cleanup. A changed sidecar remains an ownership mismatch rather than a deletion failure and is left untouched. If both a `withFileLock()` callback and release fail, the release error is the primary `SuppressedError.error` and the callback failure remains available as `SuppressedError.suppressed`. Failed asynchronous acquisition cleanup uses the same shape, with the cleanup error primary and the acquisition failure suppressed. On Node runtimes without the global `SuppressedError` constructor, fs-safe returns the equivalent `Error` shape with the same name and properties.

## API

```ts
function acquireFileLock<TPayload>(
  targetPath: string,
  options: FileLockAcquireOptions<TPayload>,
): Promise<FileLockHandle>;

function withFileLock<T, TPayload>(
  targetPath: string,
  options: FileLockAcquireOptions<TPayload>,
  fn: () => Promise<T>,
): Promise<T>;

function createFileLockManager(key: string): FileLockManager;

function acquireFileLockSync<TPayload>(targetPath: string, options: FileLockSyncAcquireOptions<TPayload>): FileLockSyncHandle;
function withFileLockSync<T, TPayload>(targetPath: string, options: FileLockSyncAcquireOptions<TPayload>, fn: () => T): T;
```

`managerKey` is an optional identifier used to keep state isolated across multiple lock domains in the same process. Use distinct keys for distinct domains (`"snapshot"`, `"compact"`, `"build"`). If omitted, fs-safe derives one from the target path.

Within one manager domain, the canonical target path is the in-process
arbitration key even when callers supply different explicit `lockPath` values.
Admission remains pending while payload serialization and stale-policy callbacks
run, and becomes reentrant only after a matching owner is fully published.
Foreign owners wait or reach the configured timeout without opening their
alternate sidecar. Each unguarded attempt still invokes and serializes `payload`
before a completed foreign holder consumes retry budget, preserving callback and
retry compatibility; the holder is rechecked before delayed option accessors or
sidecar I/O. When the candidate resolves to the holder's actual sidecar (the
default path or an explicitly identical path), asynchronous retries also preserve
the existing parser observation: bytes are observed first, then its accessor is
read and the current holder bytes are parsed once per unguarded attempt.
Distinct alternate sidecars do not trigger that observation. Async acquisition releases
pending admission before retry backoff;
synchronous callback reentry cannot let the active stack progress, so it fails
closed with the normal `file_lock_timeout` fields. Async payload, serialization,
delayed-option, and stale-policy callbacks carry a process-shared ancestry scope:
a nested acquisition of the same canonical target in the same manager domain
fails before waiting on its ancestor, while independent tasks, different targets,
and different manager domains retain their normal retry behavior. The synchronous
API uses one process-wide domain. An ancestry snapshot keeps each ancestor that
is active when the child acquisition starts, even if the current callback's own
scope already became inactive; later deactivation cannot reclassify that child.
Detached work started only after every matching ancestor has finished is not
retained as a descendant. Promise-like callback results are assimilated inside
that ancestry scope, and the resolved payload crosses the internal return
boundary in a non-thenable envelope. The helper therefore does not observe a
stateful payload `then` accessor again outside the reservation.

The pending-admission registry coordinates package copies that implement this
protocol without placing incomplete state in the legacy held-lock map. An older
already-loaded executable copy does not consult that registry, so a mixed-version
process cannot rely on the new in-process arbitration until every copy is updated
and the process is restarted.

## Acquire options

```ts
type FileLockAcquireOptions<TPayload extends Record<string, unknown>> = {
  managerKey?: string;                   // optional in-process manager namespace
  lockPath?: string;                     // override; defaults to `${targetPath}.lock`
  staleMs?: number;                      // non-negative or Infinity; default 30_000
  timeoutMs?: number;                    // overall acquire deadline; default unbounded
  retry?: FileLockRetryOptions;
  staleRecovery?: "fail-closed" | "remove-if-unchanged"; // default "fail-closed"
  reentrantOwner?: string;               // logical holder identity for owner-scoped nesting
  payload: () => TPayload | Promise<TPayload>;
  shouldReclaim?: (params: {
    lockPath: string;
    normalizedTargetPath: string;
    payload: Record<string, unknown> | null;
    staleMs: number;
    nowMs: number;
    heldByThisProcess: boolean;
  }) => boolean | Promise<boolean>;
  shouldRemoveStaleLock?: (snapshot: {
    lockPath: string;
    normalizedTargetPath: string;
    raw: string;
    payload: Record<string, unknown> | null;
  }) => boolean | Promise<boolean>;
  metadata?: Record<string, unknown>;    // attached to heldEntries() output for diagnostics
  parsePayload?: (raw: string) => unknown;
  lockRoot?: Root;
  retainOnExit?: boolean;               // keep the sidecar across process exit (default false)
  onCompromised?: (info: { lockPath: string; normalizedTargetPath: string }) => void;
  compromiseCheckIntervalMs?: number;    // 0/omitted disables; otherwise 1..2_147_483_647
};

type FileLockRetryOptions = {
  retries?: number;       // number of retry attempts after the first failure
  factor?: number;        // exponential backoff factor (default 1: constant delay)
  minTimeout?: number;    // initial delay (ms)
  maxTimeout?: number;    // delay cap (ms)
  randomize?: boolean;    // jitter
};
```

`payload` is a function so you can re-evaluate it on each retry (e.g. timestamp,
PID). Callback-valued option accessors are otherwise captured once for an
acquisition; the asynchronous same-sidecar parser observation above reads
`parsePayload` once per unguarded attempt. Callback invocation keeps its
established receiver behavior.

Asynchronous acquisition snapshots `targetPath`, an explicit `lockPath`, and
`lockRoot` before its first asynchronous operation. Cwd-dependent path spellings
are resolved using Node's platform path-resolution rules at that point, and the
resulting absolute paths remain fixed through retries, stale recovery,
verification, and release even if the process later changes its working
directory. An explicit, fully qualified `lockPath` retains its caller-supplied
spelling; current-drive-rooted and drive-relative Windows paths are resolved at
the snapshot boundary. The snapshot adds no normalization beyond what is
required to remove that cwd or current-drive dependency.

The complete serialized sidecar must fit within 1 MiB (1,048,576 UTF-8 bytes),
including pretty-printed JSON, newlines, and the internal ownership token's
trailing whitespace. The limit counts bytes, not string characters. Oversized
payloads reject with `FsSafeError` code `too-large` before sidecar creation or
acquisition, without retrying serialization or reclaiming an existing sidecar.
This bound applies to raw and Root-backed locks, both async and sync.

Errors thrown by `payload`, its JSON serialization (including `toJSON`), or
`parsePayload` propagate unchanged without retrying the callback. Rethrowing an
error saved from an earlier filesystem operation does not grant retry authority.
Retry counts must be non-negative safe integers. Retry factors and delays must be finite and non-negative, and when both delay bounds are provided `minTimeout` cannot exceed `maxTimeout`. `timeoutMs` accepts a finite non-negative deadline or positive infinity for no deadline; invalid numeric values reject before filesystem acquisition starts.
Both async and sync locks enforce retry counts and deadlines independently: an
explicit `retry.retries` still applies with `timeoutMs: Infinity`, and zero allows
only the initial attempt. After process defaults are applied, an omitted retry
count means unlimited retries, and an omitted or infinite timeout means no
deadline. With neither budget bounded, contention can wait indefinitely.
`parsePayload` replaces JSON parsing for legacy or custom sidecars. Its `unknown`
result is passed to `shouldReclaim` and `shouldRemoveStaleLock`, allowing PID,
process-start, argv, or role schemas to remain application-owned.

On Windows, a pathed `EPERM` from creating or opening the lock file can be a
short teardown race after another holder unlinks it. Both async and sync locks
retry that specific open denial at most eight times per acquisition, within the
caller's retry/deadline budget. A parent-directory denial, a callback/read/stat
failure, or exhaustion of either budget surfaces the original error; a denied
open is not converted to `file_lock_timeout`. Root-backed async creation uses
this same policy for the Windows fallback's exclusive-open denial, captured
within that individual create call. A generic `Root.create()` error or an error
replayed from an earlier call is not exclusive-open evidence. Retrying always
requires fresh exclusive creation and grants no ownership or removal authority.

## Owner-scoped reentrancy

Version 0.5 removes the unsound process-scoped `allowReentrant` boolean and
replaces it with `reentrantOwner`. When a manager already holds the canonical
target path, another acquisition reuses that sidecar only when both acquisitions
provide the same owner string. Each acquisition gets an idempotent release
handle; the sidecar remains until the last reference is released. A different or
missing owner waits under the normal contention, retry, and timeout policy. A
known live in-process holder is never stale-reclaimed by its own manager.

This supports logical session writers that may reach one file through real and
symlinked parent paths:

```ts
const managerKey = "session-write-locks";
const reentrantOwner = `session:${sessionId}:operation:${operationId}`;

const outer = await acquireFileLock(realSessionPath, {
  managerKey,
  reentrantOwner,
  staleMs: 60_000,
  payload: () => ({ pid: process.pid, operationId }),
});
const nested = await acquireFileLock(symlinkedSessionPath, {
  managerKey,
  reentrantOwner,
  staleMs: 60_000,
  payload: () => ({ pid: process.pid, operationId }),
});

await nested.release(); // sidecar remains for outer
await outer.release();  // final reference removes it
```

The manager domain and canonical target path are part of the identity, so
aliased paths must use the same `managerKey`. The owner key must identify one
logical holder or call chain. **Never use a process-wide or other shared constant
for unrelated tasks**: doing so would admit concurrent work to the same critical
section and recreate the lost-update bug that removed `allowReentrant`.

Omit `reentrantOwner` for ordinary acquisitions. `jsonStore` does so and keeps
its separate canonical-path mutation queue. The synchronous APIs implement the
same owner/refcount rules; a mismatched synchronous acquisition blocks the
calling thread according to its retry and timeout options.

Pass `lockRoot` to place sidecar create, read, verification, and removal behind
an existing `Root` capability. `lockPath` must resolve inside that root.
Identity-conditioned removal remains the only release and reclaim deletion
path.

Async Root-backed acquisition normalizes the target's parent without creating
it, checking the retained Root before and after normalization. A deleted or
replaced Root fails before payload execution or held-entry reuse. Missing lock
subdirectories are still created through `Root.create`, never by target-key
normalization. The target is an arbitration key and may be outside the Root
when an explicit in-root `lockPath` is supplied; normalization does not follow a
target-leaf symlink. Non-Root acquisition retains its existing parent-creation
behavior.

An owner can finish releasing while another async acquirer inspects its record.
Create-only Root writes do not open an existing record merely to inherit its
mode. Once a pathname sample and opened descriptor agree, a failed acquisition
snapshot can be discarded only when the original descriptor has exact identity,
was not observed with multiple links, and proves it was unlinked (`nlink === 0`).
This includes Windows resolver
`EPERM`/`EBADF` failures, with evidence captured at the failing operation before
closing the descriptor. The canonical in-root ancestor chain and Root are
rechecked; permitted in-root parent symlinks are resolved before those checks.

A contending waiter may also encounter a new holder between its pre-open
pathname inspection and opening the file. It may discard that stale observation
only when the old sample and opened descriptor have different, strictly known
regular-file identities, neither was observed with multiple links, and the
opened descriptor and complete canonical ancestry pass reinspection. This does
not prove the old pathname sample was unlinked rather than moved. The new
holder's payload is not read or adopted. Post-create admission never opts into
this pre-open-change policy.

Discarding an acquisition observation is not proof that the pathname is absent:
another owner may already have created the next record. Every discarded
observation consumes the normal retry/deadline budget and requires fresh
exclusive creation. It supplies no release, reclaim, or held-lock authority.
If that successor disappears during the recovery metadata probe, the waiter
may discard the probe only with an operation-local receipt for an admitted
regular file with one link, followed by current Root and canonical ancestor
checks. A generic metadata error does not permit this retry, and public
`Root.stat()` still rejects a file that changes during observation.
Generic `Root.open()` and held-owner/reclaim reads still reject failed opens.
Moving an already-matched pinned descriptor without unlinking it, unknown or
inexact identities, retargeted ancestors, and unrelated filesystem or caller
errors fail closed. Failure receipts belong only to the current Root observation,
including during nested or concurrent acquisitions; historical error identity
is not changed-file, unlink, or open-denial evidence.

After creating a record, the async Root-backed acquirer checks the reopened
bytes against its exact serialized payload and ownership token. A replacement
is never adopted; a descriptor observed unlinked at the end of admission is
never registered as held. Failed admission cleanup retains the original creator
receipt, so it cannot remove a replacement using a later stat alone. Native
mode changes the create mechanism, not these Root-backed admission checks.
Non-Root and synchronous snapshots retain their descriptor/read/path checks
and do not use the Root opened-path resolver.

## Release handle

```ts
type FileLockHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  verifyStillHeld: () => Promise<boolean>;
  release: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
```

`verifyStillHeld()` compares the current sidecar with the ownership snapshot
captured at acquisition. Set `compromiseCheckIntervalMs` together with
`onCompromised` for a cheap periodic check; the callback fires once after the
sidecar no longer matches or after a verification I/O failure. This is
detection, not revocation of work already in progress. Asynchronous checks are
serialized, so a slow verification never overlaps the next timer tick.

The compromise-check interval is validated before payload evaluation or
filesystem acquisition. Omit it or pass `0` to disable monitoring; enabled
intervals must be finite and between 1 and 2,147,483,647 milliseconds. Values
outside that range are rejected instead of being clamped by Node.js to an
unexpectedly tight polling loop.

## Synchronous locks

`acquireFileLockSync()` and `withFileLockSync()` mirror filesystem arbitration,
retry, payload parsing, stale policy, owner-scoped reentrancy, guarded
identity-conditioned reclaim, verification, and compromise monitoring. They do
not use the async manager queue or support async callbacks. Retry waits block
the calling thread; use the async API in request-serving code. The sync
compromise interval treats a thrown verification I/O error as a lost lock and
invokes `onCompromised` once, matching the asynchronous `.catch(() => false)`
contract. An explicit `verifyStillHeld()` call still propagates that I/O error.

Windows synchronous lock parents use the same canonical path spelling as
`root()`, including short-name expansion. With `lockRoot`, a failed parent
canonicalization or an out-of-root parent still rejects. Missing-path observations from snapshot
`lstat`/`open`, and identity-mismatched snapshots, consume the normal retry and
deadline budget. Errors from descriptor reads/stats or parsing are not treated
as missing snapshots, even when their code is `ENOENT`. Held verification,
release, and reclaim do not retry open denials.

Synchronous `lockRoot` is an authority boundary, not only a containment hint.
It requires a genuine `Root` returned by the same loaded package copy; a
structural/custom Root lookalike or a handle constructed by another installed
copy fails with `helper-unavailable` before any remaining acquisition option or
nested retry getter, payload evaluation, or filesystem effects. After reading
`lockRoot` once, the genuine Root and its policies are snapshotted before those
getters run. Construct `lockRoot` through the same import instance that provides
the synchronous lock function. The acquirer retains the original Root context,
exact root, parent, and file identities, and the Root's entry-time read, hardlink,
mutation-symlink, `denyMutations`, and `assertBeforeMutation` policies. Those
receipts remain authoritative through same-owner reuse, compromise checks,
reclaim, explicit release, and process-exit cleanup. If the Root, an admitted
parent, or the owned entry changes, cleanup leaves the ambiguous path in place.
Root-backed synchronous records and their exit handler use a separate versioned
global domain; legacy raw-lock handlers and legacy package copies cannot adopt or
pathname-delete those records. Root and raw acquisitions never share a
reentrant reference, even when their owner strings match.

As with asynchronous Root-backed acquisition, synchronous target normalization
does not create the target's parent. An explicit in-root `lockPath` can therefore
guard an external or not-yet-created target key without creating anything next
to that target. Missing directories for the sidecar itself are created one
component at a time through the retained Root policy; the returned `lockPath`
uses the admitted canonical spelling. This strengthens earlier synchronous
behavior that treated `lockRoot` as a one-time lexical/canonical bound and used
raw pathname operations afterward.

Windows Root-backed target keys use native existing-ancestor canonicalization,
so long and short spellings of the same target parent share an arbitration key.
Sidecar admission applies both the retained mutation policy and read/final-link
policy before payload evaluation; a dangling final sidecar link is rejected
without creating its target.

Exact Root, parent, and file receipts narrow replacement races but do not make a
pathname check and the following `open`, `mkdir`, `unlink`, or `rmdir` one atomic
filesystem operation. A hostile peer with direct write access can still race the
final syscall. An observed mismatch fails closed and ambiguous entries remain;
use OS-enforced directory permissions or a native descriptor-relative primitive
when that attacker model must be excluded.

Both synchronous helpers consume the [process-wide lock defaults](config.md#configurefssafelocks-config).
A synchronous retry sleep is clamped to the remaining finite deadline, so a long or jittered backoff cannot extend the configured timeout or block forever.
Per-call options take precedence, including zero values; a per-call `retry`
object replaces the entire configured retry object. A configured
`staleRecovery: "remove-if-unchanged"` still needs per-call
`shouldRemoveStaleLock` approval, and per-call `staleRecovery: "fail-closed"`
disables recovery even when the process configuration opts in.

Always release in a `finally`:

```ts
import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";

const handle = acquireFileLockSync("/var/lib/app/schema.json", {
  staleMs: 60_000,
  timeoutMs: 5_000,
  retry: { retries: 20, minTimeout: 25, maxTimeout: 250 },
  payload: () => ({ pid: process.pid, operation: "schema-migration" }),
});
try {
  if (!handle.verifyStillHeld()) throw new Error("migration lock was replaced");
  migrateSchemaSynchronously();
} finally {
  handle.release();
}
```

Failed synchronous acquisition attempts close the created descriptor once even
if its metadata cannot be read. Cleanup leaves the sidecar in place without an
exact descriptor identity. A metadata-capture failure does not replace the
acquisition error; if close or identity-checked removal also fails, the
`SuppressedError.error` is the acquisition error and `suppressed` is the cleanup
error.

The sync payload, reclaim, and parsing callbacks must also be synchronous. This
shape is appropriate for a short boot migration; it is a poor fit for a server
request because retry backoff uses a blocking wait.

If termination skips the relevant cleanup handler or cleanup fails, the sidecar remains. In particular, `process.exit()` skips asynchronous Root cleanup; await explicit release or drain during application-managed graceful shutdown. Once `staleMs` elapses (or your `shouldReclaim` returns true), acquisition fails closed by default instead of deleting by path.

## `withFileLock` — common shape made one-liner

```ts
const result = await withFileLock(
  "/var/lib/app/state.json",
  {
    managerKey: "compact",
    staleMs: 30_000,
    payload: () => ({ pid: process.pid, what: "compact" }),
  },
  async () => {
    return await runCompaction();
  },
);
```

Acquires, runs `fn`, releases regardless of success/failure. Returns the result of `fn`.

## Long-lived managers

Most callers should use `acquireFileLock()` or `withFileLock()`. Use `createFileLockManager(key)` only when a long-lived service needs diagnostics or lifecycle control over locks it currently holds:

```ts
const locks = createFileLockManager("session-writes");
const handle = await locks.acquire(sessionPath, {
  staleMs: 60_000,
  payload: () => ({ pid: process.pid }),
});

for (const held of locks.heldEntries()) {
  console.log(held.lockPath, held.acquiredAt);
}

await handle.release();
await locks.drain();
```

## Stale policy: `shouldReclaim`

The default policy treats locks whose valid `createdAt` is older than `staleMs`
as stale. A valid current or future timestamp remains authoritative under
filesystem clock skew; only absent or malformed timestamps fall back to the
sidecar `mtime`. Pass a custom callback when you want a richer notion of "is the
holder still alive":

```ts
import { kill } from "node:process";

const handle = await acquireFileLock(targetPath, {
  staleMs: 60_000,
  payload: () => ({ pid: process.pid }),
  shouldReclaim: ({ payload, nowMs, staleMs }) => {
    if (!payload) return true;
    const pid = Number(payload.pid);
    if (!Number.isFinite(pid)) return true;
    try {
      kill(pid, 0);
      return false;                     // process still alive — keep waiting
    } catch {
      return true;                      // process gone — fail closed for recovery
    }
  },
});
```

`heldByThisProcess` is true when this manager already holds the lock. A `true` result marks the observed sidecar as stale; `staleRecovery` then decides whether acquisition fails closed or attempts caller-approved removal.

## Stale recovery: guarded `remove-if-unchanged`

The default `staleRecovery: "fail-closed"` never removes third-party sidecars. Use `staleRecovery: "remove-if-unchanged"` only when your app has a reliable owner-liveness policy and can prove a stale owner cannot still be writing.

Opt-in recovery creates an exclusive `<lockPath>.reclaim` directory before the final snapshot check and unlink. Every compliant acquirer waits while that guard exists, so two reclaimers cannot perform the check/unlink race that could delete a fresh replacement lock. If another acquirer creates the replacement during the handoff, its exclusive create wins and the reclaimer leaves it untouched.

`shouldRemoveStaleLock` receives the exact lock snapshot that fs-safe inspected. The callback must approve that owner as definitely stale. If the callback is missing, returns false, or the file changed, acquisition fails closed or keeps retrying according to the normal retry policy.

A process killed during the short reclaim section can leave the empty `.reclaim` directory behind. That ambiguous state intentionally fails closed; remove the guard only under external authority that excludes every competing lock acquirer.

## What sidecar locks defend against

- **Two processes writing the same file at once.** `acquire` serializes the critical section.
- **Accidentally deleting a fresh lock during stale recovery.** Opt-in removal is serialized by the reclaim guard and rechecks the approved snapshot before unlinking.
- **Race between simultaneous acquire attempts.** `O_CREAT | O_EXCL` ensures one wins.

## What they do **not** defend against

- **Misbehaving holders that ignore the lock.** Locks are advisory — only callers that go through `acquire` are bound.
- **Unapproved stale lock deletion.** If a process crashes, use the payload and your own liveness policy before opting into guarded recovery.
- **Multi-host coordination over network filesystems.** Behavior depends on the underlying filesystem's `O_EXCL` semantics; treat as best-effort.

## Common patterns

### Compact under lock

```ts
await withFileLock(
  "/var/lib/app/db.sqlite",
  {
    staleMs: 30_000,
    payload: () => ({ pid: process.pid, what: "compact" }),
  },
  async () => {
    await runCompaction();
  },
);
```

### Try once, give up if held

```ts
try {
  await withFileLock(
    targetPath,
    { staleMs: 30_000, retry: { retries: 0 }, payload: () => ({ pid: process.pid }) },
    async () => await work(),
  );
} catch (err) {
  console.log("another process is doing this; skipping");
}
```

### Wait politely with backoff

```ts
await withFileLock(
  targetPath,
  {
    staleMs: 60_000,
    timeoutMs: 30_000,
    retry: { retries: 30, minTimeout: 100, maxTimeout: 5_000, factor: 1.7, randomize: true },
    payload: () => ({ pid: process.pid }),
  },
  async () => await work(),
);
```

## See also

- [Atomic writes](atomic.md) — single-writer atomicity that often replaces the need for a lock entirely.
- `createAsyncLock` from `@openclaw/fs-safe/advanced` — in-process serialization for a single Node process.
- [Migrating to 0.5](migrating-to-0.5.md) — choosing sync versus async lock APIs.
