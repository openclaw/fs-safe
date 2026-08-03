import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { Root } from "./root-impl.js";
import {
  readSidecarLockSnapshotSync,
  relativeSidecarLockPath,
  removeSidecarLockIfUnchangedSync,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
  type SidecarLockStaleSnapshot,
} from "./sidecar-lock-reclaim.js";
import {
  computeSidecarLockDelayMs,
  sidecarLockPayloadCreatedAtMs,
} from "./sidecar-lock-policy.js";
import type {
  SidecarLockCompromisedInfo,
  SidecarLockRetryOptions,
  SidecarLockStaleRecovery,
} from "./sidecar-lock-types.js";
import { sleepSync } from "./timing.js";

export type FileLockSyncAcquireOptions<TPayload extends Record<string, unknown>> = {
  lockPath?: string;
  staleMs?: number;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
  staleRecovery?: SidecarLockStaleRecovery;
  reentrantOwner?: string;
  payload: () => TPayload;
  shouldReclaim?: (params: {
    lockPath: string;
    normalizedTargetPath: string;
    payload: unknown;
    staleMs: number;
    nowMs: number;
    heldByThisProcess: false;
  }) => boolean;
  shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean;
  parsePayload?: (raw: string) => unknown;
  lockRoot?: Root;
  onCompromised?: (info: SidecarLockCompromisedInfo) => void;
  compromiseCheckIntervalMs?: number;
};

export type FileLockSyncHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  verifyStillHeld(): boolean;
  release(): void;
  [Symbol.dispose](): void;
};

type SyncHeldLock = {
  fd: number;
  lockPath: string;
  normalizedTargetPath: string;
  parsePayload?: (raw: string) => unknown;
  refCount: number;
  reentrantOwner?: string;
  snapshot: SidecarLockSnapshot;
  timer?: NodeJS.Timeout;
};

const SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncSidecarLocks");

function getSyncHeldLocks(): Map<string, SyncHeldLock> {
  const globalWithState = globalThis as typeof globalThis & {
    [SYNC_HELD_LOCKS_KEY]?: Map<string, SyncHeldLock>;
  };
  if (!globalWithState[SYNC_HELD_LOCKS_KEY]) {
    globalWithState[SYNC_HELD_LOCKS_KEY] = new Map();
  }
  return globalWithState[SYNC_HELD_LOCKS_KEY];
}

function verifySyncHeldLock(held: SyncHeldLock): boolean {
  const current = readSidecarLockSnapshotSync(held.lockPath, held.parsePayload);
  return !!current && sidecarLockSnapshotMatches(current, held.snapshot);
}

function releaseSyncHeldLock(held: SyncHeldLock): boolean {
  const heldLocks = getSyncHeldLocks();
  if (heldLocks.get(held.normalizedTargetPath) !== held) return false;
  held.refCount -= 1;
  if (held.refCount > 0) return false;
  heldLocks.delete(held.normalizedTargetPath);
  if (held.timer) {
    clearInterval(held.timer);
    held.timer = undefined;
  }
  fs.closeSync(held.fd);
  removeSidecarLockIfUnchangedSync(held.lockPath, held.snapshot);
  return true;
}

function createSyncHeldLockHandle(held: SyncHeldLock): FileLockSyncHandle {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSyncHeldLock(held);
  };
  return {
    lockPath: held.lockPath,
    normalizedTargetPath: held.normalizedTargetPath,
    verifyStillHeld: () => verifySyncHeldLock(held),
    release,
    [Symbol.dispose]: release,
  };
}

function normalizeTargetPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function boundedLockPath(lockPath: string, lockRoot?: Root): string {
  const resolved = path.resolve(lockPath);
  if (!lockRoot) return resolved;
  relativeSidecarLockPath(lockRoot, resolved);
  const parent = path.dirname(resolved);
  const parentReal = fs.realpathSync(parent);
  const parentRelative = path.relative(lockRoot.rootReal, parentReal);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new FsSafeError("outside-workspace", "sidecar lock parent is outside lockRoot");
  }
  return path.join(parentReal, path.basename(resolved));
}

function defaultShouldReclaim(payload: unknown, lockPath: string, staleMs: number, nowMs: number): boolean {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(payload);
  if (createdAtMs !== null) return nowMs - createdAtMs > staleMs;
  try {
    return nowMs - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function reclaimGuardExists(reclaimGuardPath: string): boolean {
  try {
    fs.lstatSync(reclaimGuardPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function acquireFileLockSync<TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockSyncAcquireOptions<TPayload>,
): FileLockSyncHandle {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const lockPath = boundedLockPath(options.lockPath ?? `${normalizedTargetPath}.lock`, options.lockRoot);
  const heldLocks = getSyncHeldLocks();
  const held = heldLocks.get(normalizedTargetPath);
  if (
    held &&
    options.reentrantOwner !== undefined &&
    held.reentrantOwner !== undefined &&
    options.reentrantOwner === held.reentrantOwner
  ) {
    held.refCount += 1;
    return createSyncHeldLockHandle(held);
  }
  const staleMs = options.staleMs ?? 30_000;
  const retry = options.retry ?? {};
  const startedAt = Date.now();
  let attempt = 0;
  const reclaimGuardPath = `${lockPath}.reclaim`;
  const waitForRetry = (): void => {
    const elapsed = Date.now() - startedAt;
    const timedOut = options.timeoutMs !== undefined && elapsed >= options.timeoutMs;
    if (timedOut || (retry.retries !== undefined && attempt >= retry.retries)) {
      throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
        code: "file_lock_timeout",
        lockPath,
        normalizedTargetPath,
      });
    }
    sleepSync(computeSidecarLockDelayMs(retry, attempt));
    attempt += 1;
  };

  while (true) {
    if (reclaimGuardExists(reclaimGuardPath)) {
      waitForRetry();
      continue;
    }
    let fd: number | undefined;
    try {
      const payload = options.payload();
      const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
      const noFollow =
        process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0;
      fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      fs.writeFileSync(fd, raw, "utf8");
      fs.fsyncSync(fd);
      const snapshot: SidecarLockSnapshot = {
        raw,
        payload,
        stat: fs.fstatSync(fd),
        ownershipToken,
      };
      const createdHeld: SyncHeldLock = {
        fd,
        lockPath,
        normalizedTargetPath,
        parsePayload: options.parsePayload,
        refCount: 1,
        reentrantOwner: options.reentrantOwner,
        snapshot,
      };
      heldLocks.set(normalizedTargetPath, createdHeld);
      const returnedHandle = createSyncHeldLockHandle(createdHeld);
      if (options.onCompromised && (options.compromiseCheckIntervalMs ?? 0) > 0) {
        createdHeld.timer = setInterval(() => {
          if (!returnedHandle.verifyStillHeld()) {
            if (createdHeld.timer) clearInterval(createdHeld.timer);
            createdHeld.timer = undefined;
            options.onCompromised?.({ lockPath, normalizedTargetPath });
          }
        }, options.compromiseCheckIntervalMs);
        createdHeld.timer.unref();
      }
      fd = undefined;
      return returnedHandle;
    } catch (error) {
      if (fd !== undefined) {
        const failed = { payload: null, stat: fs.fstatSync(fd) } satisfies SidecarLockSnapshot;
        fs.closeSync(fd);
        fd = undefined;
        removeSidecarLockIfUnchangedSync(lockPath, failed);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (heldLocks.has(normalizedTargetPath)) {
        waitForRetry();
        continue;
      }
      const snapshot = readSidecarLockSnapshotSync(lockPath, options.parsePayload, {
        rejectNonFile: true,
      });
      if (!snapshot) continue;
      const nowMs = Date.now();
      const reclaim = options.shouldReclaim
        ? options.shouldReclaim({
            lockPath,
            normalizedTargetPath,
            payload: snapshot.payload,
            staleMs,
            nowMs,
            heldByThisProcess: false,
          })
        : defaultShouldReclaim(snapshot.payload, lockPath, staleMs, nowMs);
      if (reclaim) {
        if (
          options.staleRecovery === "remove-if-unchanged" &&
          snapshot.raw !== undefined &&
          options.shouldRemoveStaleLock?.({
            lockPath,
            normalizedTargetPath,
            raw: snapshot.raw,
            payload: snapshot.payload,
          })
        ) {
          let ownsReclaimGuard = false;
          try {
            fs.mkdirSync(reclaimGuardPath);
            ownsReclaimGuard = true;
            if (removeSidecarLockIfUnchangedSync(lockPath, snapshot)) continue;
          } catch (reclaimError) {
            if ((reclaimError as NodeJS.ErrnoException).code !== "EEXIST") {
              throw reclaimError;
            }
            waitForRetry();
            continue;
          } finally {
            if (ownsReclaimGuard) {
              try {
                fs.rmdirSync(reclaimGuardPath);
              } catch {
                // A surviving reclaim guard fails closed.
              }
            }
          }
        }
        throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
          code: "file_lock_stale",
          lockPath,
          normalizedTargetPath,
        });
      }
      waitForRetry();
    }
  }
}

export function withFileLockSync<T, TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockSyncAcquireOptions<TPayload>,
  fn: () => T,
): T {
  const lock = acquireFileLockSync(targetPath, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
