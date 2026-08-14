# File lock

`acquireFileLock()` and `withFileLock()` provide a cross-process file lock with retry and process-exit cleanup. The lock is implemented as a sidecar file (e.g. `state.json` ↔ `state.json.lock`) — only one acquirer can create the sidecar with `O_CREAT | O_EXCL` at a time.

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

The library installs a `process.on("exit")` handler that releases all currently-held locks synchronously, so well-behaved exits leave no stale sidecars. Crashed holders leave their sidecar behind; recover only after an application-owned liveness policy proves the holder cannot still be writing.

Each new sidecar also carries an internal random ownership token encoded as JSON trailing whitespace. `JSON.parse()` and every payload callback still see exactly the caller-provided object. Only the process that successfully created the sidecar keeps that token as release authority; merely reading token-shaped bytes from disk does not enable this mode. Release compares the in-memory token and exact serialized bytes, and requires the pathname to remain a regular file, instead of requiring an opened descriptor and pathname lookup to report the same inode identity. This preserves ownership checks on filesystems such as Docker Desktop VirtioFS where those two views can legitimately differ. Sidecars created by older releases have no token and retain the legacy identity-plus-content check.

The raw sidecar bytes are not a canonical JSON representation: tools that trim or rewrite the trailing whitespace invalidate the ownership token, so release leaves the changed sidecar in place and fails closed. The token distinguishes cooperating acquisitions; it is not a secret and does not make pathname compare-and-remove atomic against a hostile process that can replace files outside the lock protocol.

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

## Acquire options

```ts
type FileLockAcquireOptions<TPayload extends Record<string, unknown>> = {
  managerKey?: string;                   // optional in-process manager namespace
  lockPath?: string;                     // override; defaults to `${targetPath}.lock`
  staleMs?: number;                      // default 30_000
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
  onCompromised?: (info: { lockPath: string; normalizedTargetPath: string }) => void;
  compromiseCheckIntervalMs?: number;
};

type FileLockRetryOptions = {
  retries?: number;       // number of retry attempts after the first failure
  factor?: number;        // exponential backoff factor (default 1: constant delay)
  minTimeout?: number;    // initial delay (ms)
  maxTimeout?: number;    // delay cap (ms)
  randomize?: boolean;    // jitter
};
```

`payload` is a function so you can re-evaluate it on each retry (e.g. timestamp, PID).
`parsePayload` replaces JSON parsing for legacy or custom sidecars. Its `unknown`
result is passed to `shouldReclaim` and `shouldRemoveStaleLock`, allowing PID,
process-start, argv, or role schemas to remain application-owned.

On Windows, a pathed `EPERM` from creating or opening the lock file can be a
short teardown race after another holder unlinks it. The async lock retries that
specific denial at most eight times. A parent-directory denial, a denial from a
callback, or a ninth consecutive lock-file denial surfaces as the original
`EPERM`; it is not converted to `file_lock_timeout`.

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
detection, not revocation of work already in progress.

## Synchronous locks

`acquireFileLockSync()` and `withFileLockSync()` mirror filesystem arbitration,
retry, payload parsing, stale policy, owner-scoped reentrancy, guarded
identity-conditioned reclaim, verification, and compromise monitoring. They do
not use the async manager queue or support async callbacks. Retry waits block
the calling thread; use the async API in request-serving code.

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

The sync payload, reclaim, and parsing callbacks must also be synchronous. This
shape is appropriate for a short boot migration; it is a poor fit for a server
request because retry backoff uses a blocking wait.

If your process dies before `release()` runs and skips the exit handler, the sidecar remains. Once `staleMs` elapses (or your `shouldReclaim` returns true), acquisition fails closed by default instead of deleting by path.

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
