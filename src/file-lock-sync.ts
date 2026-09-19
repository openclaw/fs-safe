import fs from "node:fs";
import { acquireFileLockSyncWithRoot } from "./file-lock-sync-root-acquire.js";
import { withSyncHeldLockHandle } from "./file-lock-sync-root-held.js";
import path from "node:path";
import type { Root } from "./root-impl.js";
import {
  readSidecarLockSnapshotSync,
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
  validateSidecarLockStaleMs,
  validateSidecarLockCompromiseCheckIntervalMs,
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
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { createSuppressedError } from "./suppressed-error.js";
import {
  ensureSyncLockExitCleanupRegistered,
  getSyncHeldLocks,
  foreignSyncHeldLock,
  getSyncLockAdmissions,
  syncReclaimGuardExists,
  syncLockTimeout,
  type SyncHeldLock,
} from "./file-lock-sync-admission.js";
import {
  handleSyncStaleAdmission,
  type SyncStaleOptionsState,
} from "./file-lock-sync-stale-admission.js";

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
  getSyncLockAdmissions().clear();
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
  return process.platform === "win32" ? realpathSync.native(parent) : realpathSync(parent);
}

function normalizeTargetPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  assertNoWindowsPathAlias(resolved);
  fs.mkdirSync(recursiveMkdirPath(path.dirname(resolved)), { recursive: true });
  let parent: string;
  try {
    parent = canonicalLockParentSync(path.dirname(resolved));
  } catch {
    return resolved;
  }
  assertNoWindowsPathAlias(parent);
  const normalized = path.join(parent, path.basename(resolved));
  assertNoWindowsPathAlias(normalized);
  return normalized;
}

export function acquireFileLockSync<TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockSyncAcquireOptions<TPayload>,
): FileLockSyncHandle {
  const lockRoot = options.lockRoot;
  if (lockRoot) return acquireFileLockSyncWithRoot(targetPath, options, lockRoot);
  const defaults = getFsSafeLockConfig();
  const retry = options.retry ?? defaults.retry ?? {};
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
  validateSidecarLockRetryOptions(retry);
  validateSidecarLockTimeoutMs(timeoutMs);
  const staleMs = options.staleMs ?? defaults.staleMs ?? 30_000;
  validateSidecarLockStaleMs(staleMs);
  const compromiseCheckIntervalMs = options.compromiseCheckIntervalMs;
  validateSidecarLockCompromiseCheckIntervalMs(compromiseCheckIntervalMs);
  const explicitLockPath = options.lockPath;
  assertNoWindowsPathAlias(targetPath);
  if (explicitLockPath !== undefined) assertNoWindowsPathAlias(explicitLockPath);
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const lockPath = path.resolve(explicitLockPath ?? `${normalizedTargetPath}.lock`);
  assertNoWindowsPathAlias(lockPath);
  const requestedReentrantOwner = options.reentrantOwner;
  const heldLocks = getSyncHeldLocks();
  const currentTargetHolder = () => heldLocks.get(normalizedTargetPath) ??
    foreignSyncHeldLock("raw", normalizedTargetPath);
  const initiallyHeld = heldLocks.get(normalizedTargetPath);
  if (
    initiallyHeld && !foreignSyncHeldLock("raw", normalizedTargetPath) &&
    requestedReentrantOwner !== undefined &&
    initiallyHeld.reentrantOwner !== undefined &&
    requestedReentrantOwner === initiallyHeld.reentrantOwner
  ) {
    initiallyHeld.refCount += 1;
    return createSyncHeldLockHandle(initiallyHeld);
  }
  const admissions = getSyncLockAdmissions();
  const admissionToken = {};
  let ownsAdmission = false;
  const hasAdmissionToken = (): boolean => admissions.get(normalizedTargetPath) === admissionToken;
  const releaseAdmission = (): void => {
    if (ownsAdmission && hasAdmissionToken()) admissions.delete(normalizedTargetPath);
    ownsAdmission = false;
  };
  let payloadCallback: typeof options.payload | undefined;
  let onCompromised: typeof options.onCompromised = undefined;
  let onCompromisedObserved = false;
  let parsePayload: typeof options.parsePayload = undefined;
  let parsePayloadObserved = false;
  let staleRecovery: SidecarLockStaleRecovery | undefined = undefined;
  let staleRecoveryObserved = false;
  const staleOptions: SyncStaleOptionsState<TPayload> = {};
  const startedAt = Date.now();
  let attempt = 0;
  let transientDenials = 0;
  const reclaimGuardPath = `${lockPath}.reclaim`;
  const waitForRetry = (): void => {
    releaseAdmission();
    const elapsed = Date.now() - startedAt;
    const timedOut = timeoutMs !== undefined && elapsed >= timeoutMs;
    if (timedOut || (retry.retries !== undefined && attempt >= retry.retries)) {
      throw syncLockTimeout(lockPath, normalizedTargetPath);
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
  const assertAdmissionToken = (): void => {
    if (!hasAdmissionToken()) throw syncLockTimeout(lockPath, normalizedTargetPath);
  };
  const runAdmissionBoundary = <T>(callback: () => T): T => {
    assertAdmissionToken();
    try { return callback(); }
    finally { assertAdmissionToken(); }
  };

  try {
    while (true) {
      if (!ownsAdmission) {
        const held = heldLocks.get(normalizedTargetPath);
        if (
          held && !foreignSyncHeldLock("raw", normalizedTargetPath) &&
          requestedReentrantOwner !== undefined &&
          held.reentrantOwner !== undefined &&
          requestedReentrantOwner === held.reentrantOwner
        ) {
          held.refCount += 1;
          return createSyncHeldLockHandle(held);
        }
        if (admissions.has(normalizedTargetPath)) {
          // The owner can only finish after this synchronous callback unwinds.
          throw syncLockTimeout(lockPath, normalizedTargetPath);
        }
        admissions.set(normalizedTargetPath, admissionToken);
        ownsAdmission = true;
      }
      const attemptHeld = currentTargetHolder();
      const holderWasReplaced = (): boolean => {
        const current = currentTargetHolder();
        return current !== undefined && current !== attemptHeld;
      };
      if (!staleRecoveryObserved) {
        staleRecovery = runAdmissionBoundary(() =>
          options.staleRecovery ?? defaults.staleRecovery);
        staleRecoveryObserved = true;
        if (holderWasReplaced()) { waitForRetry(); continue; }
      }
      const reclaimGuardExists = syncReclaimGuardExists(reclaimGuardPath);
      if (!hasAdmissionToken()) throw syncLockTimeout(lockPath, normalizedTargetPath);
      if (holderWasReplaced()) { waitForRetry(); continue; }
      if (reclaimGuardExists) {
        waitForRetry();
        continue;
      }
      let fd: number | undefined;
      let createdHeld: SyncHeldLock | undefined;
      let createdSnapshot: SidecarLockSnapshot | undefined;
      if (!payloadCallback) payloadCallback = runAdmissionBoundary(() => options.payload);
      if (holderWasReplaced()) { waitForRetry(); continue; }
      const payload = runAdmissionBoundary(() => Reflect.apply(payloadCallback!, options, []));
      if (holderWasReplaced()) { waitForRetry(); continue; }
      const { raw, ownershipToken } = runAdmissionBoundary(() =>
        serializeSidecarLockPayload(payload));
      if (holderWasReplaced()) { waitForRetry(); continue; }
      if (currentTargetHolder() !== undefined) { waitForRetry(); continue; }
      if (!onCompromisedObserved) {
        onCompromised = runAdmissionBoundary(() => options.onCompromised);
        onCompromisedObserved = true;
        if (currentTargetHolder() !== undefined) { waitForRetry(); continue; }
      }
      if (!parsePayloadObserved) {
        parsePayload = runAdmissionBoundary(() => options.parsePayload);
        parsePayloadObserved = true;
        if (currentTargetHolder() !== undefined) { waitForRetry(); continue; }
      }
      let lockFileCreateDenied = false;
      let exclusiveCreateConflict = false;
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
          exclusiveCreateConflict = (error as NodeJS.ErrnoException).code === "EEXIST";
          throw error;
        }
        fs.writeFileSync(fd, raw, "utf8");
        fs.fsyncSync(fd);
        createdSnapshot = {
          raw,
          payload,
          stat: fs.fstatSync(fd),
          ownershipToken,
        };
        createdHeld = {
          fd,
          lockPath,
          normalizedTargetPath,
          parsePayload,
          refCount: 1,
          reentrantOwner: requestedReentrantOwner,
          snapshot: createdSnapshot,
        };
        const candidateHeld = createdHeld;
        ensureSyncLockExitCleanupRegistered(
          releaseAllSyncHeldLocks,
          lockPath,
          normalizedTargetPath,
        );
        if (!hasAdmissionToken() || currentTargetHolder() !== undefined) {
          throw syncLockTimeout(lockPath, normalizedTargetPath);
        }
        const returnedHandle = createSyncHeldLockHandle(candidateHeld);
        if (onCompromised && (compromiseCheckIntervalMs ?? 0) > 0) {
          const compromisedCallback = onCompromised;
          candidateHeld.timer = setInterval(() => {
            let stillHeld: boolean;
            try {
              stillHeld = returnedHandle.verifyStillHeld();
            } catch {
              stillHeld = false;
            }
            if (!stillHeld && candidateHeld.timer) {
              clearInterval(candidateHeld.timer);
              candidateHeld.timer = undefined;
              Reflect.apply(compromisedCallback, options, [{ lockPath, normalizedTargetPath }]);
            }
          }, compromiseCheckIntervalMs);
          candidateHeld.timer.unref();
        }
        if (
          !hasAdmissionToken() ||
          currentTargetHolder() !== undefined
        ) {
          throw syncLockTimeout(lockPath, normalizedTargetPath);
        }
        heldLocks.set(normalizedTargetPath, candidateHeld);
        releaseAdmission();
        fd = undefined;
        return returnedHandle;
      } catch (error) {
        if (createdHeld?.timer) {
          clearInterval(createdHeld.timer);
          createdHeld.timer = undefined;
        }
        if (createdHeld && heldLocks.get(normalizedTargetPath) === createdHeld) {
          heldLocks.delete(normalizedTargetPath);
        }
        if (fd !== undefined) {
          const failed: SidecarLockSnapshot = createdSnapshot ?? { payload: null };
          if (!failed.stat) {
            try {
              failed.stat = fs.fstatSync(fd);
            } catch {
              // Missing identity leaves the sidecar in place, but must not skip close.
            }
          }
          const failedFd = fd;
          fd = undefined;
          if (createdHeld) createdHeld.fd = undefined;
          try {
            fs.closeSync(failedFd);
            if (failed.stat) removeSidecarLockIfUnchangedSync(lockPath, failed);
          } catch (cleanupError) {
            throw createSuppressedError(
              error,
              cleanupError,
              "file lock acquisition and cleanup both failed",
            );
          }
        }
        if (lockFileCreateDenied) {
          if (!hasAdmissionToken()) throw syncLockTimeout(lockPath, normalizedTargetPath);
          if (currentTargetHolder() !== undefined) { waitForRetry(); continue; }
          if (retryLockFileDenial(error)) continue;
          throw error;
        }
        if (!exclusiveCreateConflict) throw error;
        if (!hasAdmissionToken()) throw syncLockTimeout(lockPath, normalizedTargetPath);
        if (currentTargetHolder() !== undefined) {
          waitForRetry();
          continue;
        }
        handleSyncStaleAdmission({
          hasToken: hasAdmissionToken,
          currentHeld: currentTargetHolder,
          lockPath,
          normalizedTargetPath,
          options,
          parsePayload,
          reclaimGuardPath,
          retryLockFileDenial,
          staleMs,
          staleOptions,
          staleRecovery,
          waitForRetry,
        });
        continue;
      }
    }
  } finally {
    releaseAdmission();
  }
}

export function withFileLockSync<T, TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockSyncAcquireOptions<TPayload>,
  fn: () => T,
): T {
  const lock = acquireFileLockSync(targetPath, options);
  return withSyncHeldLockHandle(lock, fn);
}
