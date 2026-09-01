import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { Root } from "./root-impl.js";
import {
  readSidecarLockSnapshotSync,
  readSidecarLockRawSnapshotSync,
  parseSidecarLockSnapshot,
  relativeSidecarLockPath,
  removeSidecarLockIfUnchangedSync,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
  type SidecarLockStaleSnapshot,
} from "./sidecar-lock-reclaim.js";
import {
  computeSidecarLockDelayMs,
  isTransientLockFileDenial,
  maxTransientLockDenials,
  sidecarLockPayloadCreatedAtMs,
  validateSidecarLockRetryOptions,
  validateSidecarLockTimeoutMs,
} from "./sidecar-lock-policy.js";
import type {
  SidecarLockCompromisedInfo,
  SidecarLockRetryOptions,
  SidecarLockStaleRecovery,
} from "./sidecar-lock-types.js";
import { getFsSafeLockConfig } from "./lock-config.js";
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
  fd: number | undefined;
  lockPath: string;
  normalizedTargetPath: string;
  parsePayload?: (raw: string) => unknown;
  refCount: number;
  reentrantOwner?: string;
  snapshot: SidecarLockSnapshot;
  timer?: NodeJS.Timeout;
};

const SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncSidecarLocks");
const SYNC_CLEANUP_REGISTERED_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupRegistered");
const SYNC_CLEANUP_HANDLER_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");

function getSyncHeldLocks(): Map<string, SyncHeldLock> {
  const globalWithState = globalThis as typeof globalThis & {
    [SYNC_HELD_LOCKS_KEY]?: Map<string, SyncHeldLock>;
  };
  if (!globalWithState[SYNC_HELD_LOCKS_KEY]) {
    globalWithState[SYNC_HELD_LOCKS_KEY] = new Map();
  }
  return globalWithState[SYNC_HELD_LOCKS_KEY];
}

function releaseAllSyncHeldLocks(): void {
  const heldLocks = getSyncHeldLocks();
  for (const [normalizedTargetPath, held] of heldLocks) {
    if (held.timer) {
      clearInterval(held.timer);
      held.timer = undefined;
    }
    try {
      if (held.fd !== undefined) fs.closeSync(held.fd);
    } catch {
      // Best-effort process-exit cleanup.
    }
    try {
      removeSidecarLockIfUnchangedSync(held.lockPath, held.snapshot);
    } catch {
      // A surviving sidecar fails closed and can be reclaimed by policy.
    }
    heldLocks.delete(normalizedTargetPath);
  }
}

function ensureSyncExitCleanupRegistered(): void {
  const globalWithCleanup = globalThis as typeof globalThis & {
    [SYNC_CLEANUP_REGISTERED_KEY]?: boolean;
    [SYNC_CLEANUP_HANDLER_KEY]?: () => void;
  };
  if (globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY]) return;
  globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY] = true;
  globalWithCleanup[SYNC_CLEANUP_HANDLER_KEY] = releaseAllSyncHeldLocks;
  process.on("exit", releaseAllSyncHeldLocks);
}

function verifySyncHeldLock(held: SyncHeldLock): boolean {
  const current = readSidecarLockSnapshotSync(held.lockPath, held.parsePayload);
  return !!current && sidecarLockSnapshotMatches(current, held.snapshot);
}

function releaseSyncHeldLock(held: SyncHeldLock): boolean {
  const heldLocks = getSyncHeldLocks();
  if (heldLocks.get(held.normalizedTargetPath) !== held) return false;
  if (held.refCount > 1) {
    held.refCount -= 1;
    return false;
  }
  // Keep the final reference and cleanup receipt until deletion succeeds.
  if (held.timer) {
    clearInterval(held.timer);
    held.timer = undefined;
  }
  if (held.fd !== undefined) {
    const fd = held.fd;
    // A close error may still free the number; consume ownership before closing.
    held.fd = undefined;
    fs.closeSync(fd);
  }
  removeSidecarLockIfUnchangedSync(held.lockPath, held.snapshot);
  heldLocks.delete(held.normalizedTargetPath);
  return true;
}

function createSyncHeldLockHandle(held: SyncHeldLock): FileLockSyncHandle {
  let released = false;
  const release = () => {
    if (released) return;
    releaseSyncHeldLock(held);
    released = true;
  };
  return {
    lockPath: held.lockPath,
    normalizedTargetPath: held.normalizedTargetPath,
    verifyStillHeld: () => verifySyncHeldLock(held),
    release,
    [Symbol.dispose]: release,
  };
}

function canonicalLockParentSync(parent: string): string {
  // Match Root's async realpath, including Windows short-name expansion.
  return process.platform === "win32" ? fs.realpathSync.native(parent) : fs.realpathSync(parent);
}

function normalizeTargetPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    return path.join(canonicalLockParentSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function boundedLockPath(lockPath: string, lockRoot?: Root): string {
  const resolved = path.resolve(lockPath);
  if (!lockRoot) return resolved;
  relativeSidecarLockPath(lockRoot, resolved);
  const parent = path.dirname(resolved);
  const parentReal = canonicalLockParentSync(parent);
  const parentRelative = path.relative(lockRoot.rootReal, parentReal);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new FsSafeError("outside-workspace", "sidecar lock parent is outside lockRoot");
  }
  return path.join(parentReal, path.basename(resolved));
}

function defaultShouldReclaim(snapshot: SidecarLockSnapshot, staleMs: number, nowMs: number): boolean {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(snapshot.payload);
  if (createdAtMs !== null) return nowMs - createdAtMs > staleMs;
  // A cooperating holder can unlink after the snapshot; use its observed age.
  return !snapshot.stat || nowMs - snapshot.stat.mtimeMs > staleMs;
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
  const defaults = getFsSafeLockConfig();
  const retry = options.retry ?? defaults.retry ?? {};
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
  validateSidecarLockRetryOptions(retry);
  validateSidecarLockTimeoutMs(timeoutMs);
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
  // Process defaults fill the same fields here as withLockDefaults() fills for
  // the asynchronous manager, so both acquirers honor configureFsSafeLocks().
  const staleMs = options.staleMs ?? defaults.staleMs ?? 30_000;
  const staleRecovery = options.staleRecovery ?? defaults.staleRecovery;
  const startedAt = Date.now();
  let attempt = 0;
  let transientDenials = 0;
  const reclaimGuardPath = `${lockPath}.reclaim`;
  const waitForRetry = (): void => {
    const elapsed = Date.now() - startedAt;
    const timedOut = timeoutMs !== undefined && elapsed >= timeoutMs;
    if (timedOut || (retry.retries !== undefined && attempt >= retry.retries)) {
      throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
        code: "file_lock_timeout",
        lockPath,
        normalizedTargetPath,
      });
    }
    const remaining =
      timeoutMs === undefined || timeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, timeoutMs - elapsed);
    sleepSync(Math.min(computeSidecarLockDelayMs(retry, attempt), remaining));
    attempt += 1;
  };
  const retryLockFileDenial = (error: unknown): boolean => {
    if (!isTransientLockFileDenial(error, lockPath) ||
      ++transientDenials > maxTransientLockDenials) return false;
    try {
      waitForRetry();
    } catch (waitError) {
      // Preserve the filesystem diagnosis when the caller's budget runs out.
      if ((waitError as NodeJS.ErrnoException).code === "file_lock_timeout") throw error;
      throw waitError;
    }
    return true;
  };

  while (true) {
    if (reclaimGuardExists(reclaimGuardPath)) {
      waitForRetry();
      continue;
    }
    let fd: number | undefined;
    const payload = options.payload();
    const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
    let lockFileCreateDenied = false;
    try {
      const noFollow =
        process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0;
      try {
        fd = fs.openSync(
          lockPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          0o600,
        );
      } catch (error) {
        lockFileCreateDenied = isTransientLockFileDenial(error, lockPath);
        throw error;
      }
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
      ensureSyncExitCleanupRegistered();
      const returnedHandle = createSyncHeldLockHandle(createdHeld);
      if (options.onCompromised && (options.compromiseCheckIntervalMs ?? 0) > 0) {
        createdHeld.timer = setInterval(() => {
          let stillHeld: boolean;
          try {
            stillHeld = returnedHandle.verifyStillHeld();
          } catch {
            stillHeld = false;
          }
          if (!stillHeld && createdHeld.timer) {
            clearInterval(createdHeld.timer);
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
      if (lockFileCreateDenied && retryLockFileDenial(error)) continue;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (heldLocks.has(normalizedTargetPath)) {
        waitForRetry();
        continue;
      }
      let rawSnapshot: ReturnType<typeof readSidecarLockRawSnapshotSync>;
      let lockFileOpenDenied = false;
      try {
        rawSnapshot = readSidecarLockRawSnapshotSync(lockPath, {
          rejectNonFile: true,
          onOpenFailure: (error) => { lockFileOpenDenied = isTransientLockFileDenial(error, lockPath); },
        });
      } catch (readError) {
        if (lockFileOpenDenied && retryLockFileDenial(readError)) continue;
        throw readError;
      }
      const snapshot = parseSidecarLockSnapshot(rawSnapshot, options.parsePayload);
      if (!snapshot) {
        waitForRetry();
        continue;
      }
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
        : defaultShouldReclaim(snapshot, staleMs, nowMs);
      if (reclaim) {
        if (
          staleRecovery === "remove-if-unchanged" &&
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
