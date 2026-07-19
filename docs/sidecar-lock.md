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
  allowReentrant?: boolean;              // if this process already holds it, increment a count instead of failing
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
};

type FileLockRetryOptions = {
  retries?: number;       // number of retry attempts after the first failure
  factor?: number;        // exponential backoff factor (default 2)
  minTimeout?: number;    // initial delay (ms)
  maxTimeout?: number;    // delay cap (ms)
  randomize?: boolean;    // jitter
};
```

`payload` is a function so you can re-evaluate it on each retry (e.g. timestamp, PID).

## Release handle

```ts
type FileLockHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  release: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
```

Always release in a `finally`:

```ts
const handle = await acquireFileLock(targetPath, {
  staleMs: 60_000,
  payload: () => ({ pid: process.pid }),
});
try {
  await doExclusiveWork();
} finally {
  await handle.release();
}
```

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

The default policy treats locks whose `createdAt` is older than `staleMs` as stale. Pass a custom callback when you want a richer notion of "is the holder still alive":

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

`heldByThisProcess` is true when this manager already holds the lock (relevant for the reentrant case). A `true` result marks the observed sidecar as stale; `staleRecovery` then decides whether acquisition fails closed or attempts caller-approved removal.

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
