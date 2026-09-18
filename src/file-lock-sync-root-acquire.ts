import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type {
  FileLockSyncAcquireOptions,
  FileLockSyncHandle,
} from "./file-lock-sync.js";
import { captureRootSyncAcquireOptions } from "./file-lock-sync-root-options.js";
import { foreignSyncHeldLock, getSyncLockAdmissions, syncLockTimeout } from "./file-lock-sync-admission.js";
import type { Root } from "./root-impl.js";
import {
  computeSidecarLockDelayMs,
  isTransientLockFileDenial,
  maxTransientLockDenials,
  sidecarLockPayloadCreatedAtMs,
} from "./sidecar-lock-policy.js";
import {
  serializeSidecarLockPayload,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import { createSuppressedError } from "./suppressed-error.js";
import { sleepSync } from "./timing.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import {
  admitFileLockSyncRootPath,
  assertFileLockSyncRootPathsCurrent,
  captureFileLockSyncRootAuthority,
  normalizeFileLockSyncTargetWithRoot,
} from "./file-lock-sync-root.js";
import {
  cleanupCreatedRootSyncLock,
  FileLockSyncRootArbitrationCollision,
  tryReuseCurrentRootSyncHeldLock,
  type FileLockSyncRootArbitration,
} from "./file-lock-sync-root-arbitration.js";
import {
  fileLockSyncRootSnapshotStillCurrent,
  type FileLockSyncRootDirectoryReceipt,
  type FileLockSyncRootFileReceipt,
  type FileLockSyncRootSnapshot,
} from "./file-lock-sync-root-io.js";
import {
  createFileLockSyncRootDirectory,
  createFileLockSyncRootFile,
  fileLockSyncRootGuardExists,
  fileLockSyncRootDirectoryReceiptStillCurrent,
  refreshFileLockSyncRootFileReceipt,
  removeFileLockSyncRootDirectory,
  removeFileLockSyncRootFile,
} from "./file-lock-sync-root-mutation.js";
import {
  createRootSyncHeldLockHandle,
  ensureRootSyncExitCleanupRegistered,
  getRootSyncHeldLocks,
  readRootSidecarSnapshotSync,
  type RootSyncHeldLock,
} from "./file-lock-sync-root-held.js";

function defaultShouldReclaim(
  snapshot: SidecarLockSnapshot,
  staleMs: number,
  nowMs: number,
): boolean {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(snapshot.payload);
  if (createdAtMs !== null) return nowMs - createdAtMs > staleMs;
  // A cooperating holder can unlink after the snapshot; use its observed age.
  return !snapshot.stat || nowMs - snapshot.stat.mtimeMs > staleMs;
}

export function acquireFileLockSyncWithRoot<TPayload extends Record<string, unknown>>(
  targetPath: string,
  inputOptions: FileLockSyncAcquireOptions<TPayload>,
  lockRoot: Root,
): FileLockSyncHandle {
  // The public dispatcher already read lockRoot exactly once. Validate and
  // snapshot that genuine Root before any remaining option or retry getter can
  // mutate its defaults or retained policy inputs.
  const authority = captureFileLockSyncRootAuthority(lockRoot);
  const options = captureRootSyncAcquireOptions(inputOptions, lockRoot);
  ensureRootSyncExitCleanupRegistered();
  assertNoWindowsPathAlias(targetPath);
  if (options.lockPath !== undefined) assertNoWindowsPathAlias(options.lockPath);
  const resolvedTargetPath = path.resolve(targetPath);
  const normalizedTargetPath = normalizeFileLockSyncTargetWithRoot(authority, resolvedTargetPath);
  const requestedLockPath = path.resolve(options.lockPath ?? `${normalizedTargetPath}.lock`);
  const lockRootPath = admitFileLockSyncRootPath(authority, requestedLockPath);
  // A followed final alias and its admitted canonical spelling name the same
  // sidecar. Derive their arbitration guard from that shared admitted path,
  // then independently admit the derived mutation target under Root policy.
  const reclaimRootPath = admitFileLockSyncRootPath(authority, `${lockRootPath.path}.reclaim`);
  const guardedPaths = Object.freeze([lockRootPath, reclaimRootPath]);
  const lockPath = lockRootPath.path;
  const heldLocks = getRootSyncHeldLocks();
  const currentTargetHolder = () => heldLocks.get(normalizedTargetPath) ??
    foreignSyncHeldLock("root", normalizedTargetPath);
  const admissions = getSyncLockAdmissions();
  const admissionToken = {};
  let ownsAdmission = false;
  const assertAdmission = () => {
    if (admissions.get(normalizedTargetPath) !== admissionToken) {
      throw syncLockTimeout(lockPath, normalizedTargetPath);
    }
  };
  const releaseAdmission = () => {
    if (ownsAdmission && admissions.get(normalizedTargetPath) === admissionToken) {
      admissions.delete(normalizedTargetPath);
    }
    ownsAdmission = false;
  };
  const arbitration: FileLockSyncRootArbitration = Object.freeze({
    authority,
    heldLocks,
    lockRootPath,
    normalizedTargetPath,
    reentrantOwner: options.reentrantOwner,
  });
  if (heldLocks.has(normalizedTargetPath) && !foreignSyncHeldLock("root", normalizedTargetPath)) {
    assertFileLockSyncRootPathsCurrent(guardedPaths, true, true);
    const initiallyReusable = tryReuseCurrentRootSyncHeldLock(arbitration);
    if (initiallyReusable) return initiallyReusable;
  }

  const startedAt = Date.now();
  let attempt = 0;
  let transientDenials = 0;
  let ownedReclaimGuard: FileLockSyncRootDirectoryReceipt | undefined;
  let reclaimCleanupAttempted = false;
  const reuseCurrentHeld = (): FileLockSyncHandle | undefined =>
    ownedReclaimGuard ? undefined : tryReuseCurrentRootSyncHeldLock(arbitration);
  const waitForRetry = (): void => {
    releaseAdmission();
    const elapsed = Date.now() - startedAt;
    const timedOut = options.timeoutMs !== undefined && elapsed >= options.timeoutMs;
    if (timedOut || (options.retry.retries !== undefined && attempt >= options.retry.retries)) {
      throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
        code: "file_lock_timeout",
        lockPath,
        normalizedTargetPath,
      });
    }
    const remaining =
      options.timeoutMs === undefined || options.timeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.timeoutMs - elapsed);
    sleepSync(Math.min(computeSidecarLockDelayMs(options.retry, attempt), remaining));
    attempt += 1;
  };
  const retryLockFileDenial = (error: unknown): boolean => {
    if (!isTransientLockFileDenial(error, lockPath) ||
      ++transientDenials > maxTransientLockDenials) return false;
    try {
      waitForRetry();
    } catch (waitError) {
      if ((waitError as NodeJS.ErrnoException).code === "file_lock_timeout") throw error;
      throw waitError;
    }
    return true;
  };
  const releaseReclaimGuard = (): void => {
    const receipt = ownedReclaimGuard;
    if (!receipt) return;
    reclaimCleanupAttempted = true;
    if (!removeFileLockSyncRootDirectory(reclaimRootPath, receipt)) {
      throw new FsSafeError("path-mismatch", "owned sidecar reclaim guard changed before release");
    }
    ownedReclaimGuard = undefined;
    reclaimCleanupAttempted = false;
  };
  const assertOwnedReclaimGuardCurrent = (): void => {
    const receipt = ownedReclaimGuard;
    if (!receipt || !fileLockSyncRootDirectoryReceiptStillCurrent(reclaimRootPath, receipt)) {
      throw new FsSafeError("path-mismatch", "owned sidecar reclaim guard changed during acquisition");
    }
  };
  try {
    while (true) {
      if (!ownsAdmission) {
        if (admissions.has(normalizedTargetPath)) throw syncLockTimeout(lockPath, normalizedTargetPath);
        admissions.set(normalizedTargetPath, admissionToken);
        ownsAdmission = true;
      }
      assertAdmission();
      assertFileLockSyncRootPathsCurrent(guardedPaths, true, true);
      assertAdmission();
      if (ownedReclaimGuard) assertOwnedReclaimGuardCurrent();
      if (!ownedReclaimGuard && fileLockSyncRootGuardExists(reclaimRootPath, true)) {
        waitForRetry();
        continue;
      }
      if (currentTargetHolder() !== undefined) {
        const reused = reuseCurrentHeld();
        if (reused) return reused;
      }
      const payload = Reflect.apply(options.payload, options.optionsReceiver, []);
      assertAdmission();
      const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
      assertAdmission();
      if (ownedReclaimGuard) assertOwnedReclaimGuardCurrent();
      if (currentTargetHolder() !== undefined) {
        const reused = reuseCurrentHeld();
        if (reused) return reused;
        waitForRetry();
        continue;
      }
      let fd: number | undefined;
      let rootReceipt: FileLockSyncRootFileReceipt | undefined;
      let unpublishedTimer: NodeJS.Timeout | undefined;
      let lockFileCreateOpenFailure: { error: unknown } | undefined;
      try {
        const created = createFileLockSyncRootFile(lockRootPath, 0o600, {
          assertBeforeOpen: () => {
            assertAdmission();
            if (ownedReclaimGuard) assertOwnedReclaimGuardCurrent();
            if (currentTargetHolder() !== undefined) throw new FileLockSyncRootArbitrationCollision();
          },
          onOpenFailure: (error) => {
            lockFileCreateOpenFailure = { error };
          },
        });
        fd = created.fd;
        rootReceipt = created.receipt;
        fs.writeFileSync(fd, raw, "utf8");
        fs.fsyncSync(fd);
        const snapshot: SidecarLockSnapshot = {
          raw,
          payload,
          ownershipToken,
        };
        if (ownedReclaimGuard) releaseReclaimGuard();
        rootReceipt = refreshFileLockSyncRootFileReceipt(lockRootPath, rootReceipt);
        const createdHeld: RootSyncHeldLock = {
          fd,
          lockPath,
          normalizedTargetPath,
          parsePayload: options.parsePayload,
          refCount: 1,
          reentrantOwner: options.reentrantOwner,
          releaseState: "active",
          revision: 0,
          rootAuthority: authority,
          rootPath: lockRootPath,
          rootReceipt,
          snapshot,
        };
        const returnedHandle = createRootSyncHeldLockHandle(createdHeld);
        if (options.onCompromised && (options.compromiseCheckIntervalMs ?? 0) > 0) {
          const timer = setInterval(() => {
            let stillHeld: boolean;
            try {
              stillHeld = returnedHandle.verifyStillHeld();
            } catch {
              stillHeld = false;
            }
            if (!stillHeld && createdHeld.timer) {
              clearInterval(createdHeld.timer);
              createdHeld.timer = undefined;
              Reflect.apply(options.onCompromised!, options.optionsReceiver,
                [{ lockPath, normalizedTargetPath }]);
            }
          }, options.compromiseCheckIntervalMs);
          unpublishedTimer = timer;
          createdHeld.timer = timer;
          timer.unref();
        }
        if (currentTargetHolder() !== undefined) {
          throw new FileLockSyncRootArbitrationCollision();
        }
        assertAdmission();
        heldLocks.set(normalizedTargetPath, createdHeld);
        fd = undefined;
        unpublishedTimer = undefined;
        return returnedHandle;
      } catch (error) {
        if (fd !== undefined && rootReceipt) {
          const cleanupFd = fd;
          const cleanupReceipt = rootReceipt;
          const cleanupTimer = unpublishedTimer;
          fd = undefined;
          rootReceipt = undefined;
          unpublishedTimer = undefined;
          try {
            cleanupCreatedRootSyncLock(lockRootPath, cleanupFd, cleanupReceipt, cleanupTimer);
          } catch (cleanupError) {
            throw createSuppressedError(
              error,
              cleanupError,
              "file lock acquisition and Root cleanup both failed",
            );
          }
        }
        if (error instanceof FileLockSyncRootArbitrationCollision) {
          const reused = reuseCurrentHeld();
          if (reused) return reused;
          waitForRetry();
          continue;
        }
        const fromLockFileOpen = lockFileCreateOpenFailure !== undefined &&
          lockFileCreateOpenFailure.error === error;
        if (fromLockFileOpen && retryLockFileDenial(error)) continue;
        if (!fromLockFileOpen || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (ownedReclaimGuard) {
          releaseReclaimGuard();
          const reused = reuseCurrentHeld();
          if (reused) return reused;
          waitForRetry();
          continue;
        }
        if (currentTargetHolder() !== undefined) {
          const reused = reuseCurrentHeld();
          if (reused) return reused;
          waitForRetry();
          continue;
        }
        let lockFileOpenDenied = false;
        let current: FileLockSyncRootSnapshot | null;
        try {
          current = readRootSidecarSnapshotSync(
            lockRootPath,
            options.parsePayload,
            (openError) => {
              lockFileOpenDenied = isTransientLockFileDenial(openError, lockPath);
            },
          );
        } catch (readError) {
          if (lockFileOpenDenied && retryLockFileDenial(readError)) continue;
          throw readError;
        }
        if (currentTargetHolder() !== undefined) {
          const reused = reuseCurrentHeld();
          if (reused) return reused;
          waitForRetry();
          continue;
        }
        assertAdmission();
        if (!current) {
          waitForRetry();
          continue;
        }
        const snapshot = current.snapshot;
        const nowMs = Date.now();
        let reclaim: boolean;
        if (options.shouldReclaim) {
          reclaim = Reflect.apply(options.shouldReclaim, options.optionsReceiver, [{
            lockPath,
            normalizedTargetPath,
            payload: snapshot.payload,
            staleMs: options.staleMs,
            nowMs,
            heldByThisProcess: false,
          }]);
          assertAdmission();
          if (!fileLockSyncRootSnapshotStillCurrent(lockRootPath, current)) {
            throw new FsSafeError("path-mismatch", "sidecar changed during reclaim policy callback");
          }
        } else {
          reclaim = defaultShouldReclaim(snapshot, options.staleMs, nowMs);
        }
        if (reclaim) {
          if (
            options.staleRecovery === "remove-if-unchanged" &&
            snapshot.raw !== undefined &&
            options.shouldRemoveStaleLock
          ) {
            const guard = createFileLockSyncRootDirectory(reclaimRootPath);
            if (!guard) {
              waitForRetry();
              continue;
            }
            ownedReclaimGuard = guard;
            reclaimCleanupAttempted = false;
            const approved = Reflect.apply(options.shouldRemoveStaleLock, options.optionsReceiver, [{
              lockPath,
              normalizedTargetPath,
              raw: snapshot.raw,
              payload: snapshot.payload,
            }]);
            assertAdmission();
            assertOwnedReclaimGuardCurrent();
            if (approved) {
              const removed = removeFileLockSyncRootFile(
                lockRootPath,
                current.receipt,
                snapshot,
                () => {
                  assertAdmission();
                  assertOwnedReclaimGuardCurrent();
                  if (currentTargetHolder() !== undefined) throw new FileLockSyncRootArbitrationCollision();
                },
              );
              if (!removed) {
                throw new FsSafeError("path-mismatch", "stale sidecar changed before removal");
              }
              continue;
            }
            if (!fileLockSyncRootSnapshotStillCurrent(lockRootPath, current)) {
              throw new FsSafeError(
                "path-mismatch",
                "sidecar changed during stale-removal policy callback",
              );
            }
            releaseReclaimGuard();
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
  } catch (error) {
    if (ownedReclaimGuard && !reclaimCleanupAttempted) {
      try {
        releaseReclaimGuard();
      } catch (cleanupError) {
        throw createSuppressedError(
          error,
          cleanupError,
          "file lock acquisition and reclaim cleanup both failed",
        );
      }
    }
    throw error;
  } finally {
    releaseAdmission();
  }
}
