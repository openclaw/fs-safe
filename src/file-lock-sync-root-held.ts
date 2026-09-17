import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import type {
  FileLockSyncHandle,
} from "./file-lock-sync.js";
import {
  parseSidecarLockPayload,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import { createSuppressedError } from "./suppressed-error.js";
import {
  type FileLockSyncRootAuthority,
  type FileLockSyncRootPath,
} from "./file-lock-sync-root.js";
import {
  fileLockSyncRootReceiptStillCurrent,
  fileLockSyncRootSnapshotStillCurrent,
  readFileLockSyncRootSnapshot,
  type FileLockSyncRootFileReceipt,
  type FileLockSyncRootSnapshot,
} from "./file-lock-sync-root-io.js";
import { removeFileLockSyncRootFile } from "./file-lock-sync-root-mutation.js";
import { ensureFileLockSyncRootExitCleanupRegistered } from "./file-lock-sync-root-registration.js";

const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");
const ROOT_SYNC_CLEANUP_ACTIVE_KEY = Symbol.for("fsSafe.syncRootSidecarLockCleanupActive.v1");
const MAX_CONTINUITY_CLEANUP_ATTEMPTS = 2;

type RootSyncHeldLockReleaseState = "active" | "releasing" | "exit-cleaning" | "released";

type RootSyncHeldLockHandleDisposition = {
  held: RootSyncHeldLock;
  released: boolean;
};

const rootSyncHandleDispositions = new WeakMap<
  FileLockSyncHandle,
  RootSyncHeldLockHandleDisposition
>();

export type RootSyncHeldLock = {
  deferredExitReleases?: Set<RootSyncHeldLockHandleDisposition>;
  fd: number | undefined;
  lockPath: string;
  normalizedTargetPath: string;
  parsePayload?: (raw: string) => unknown;
  refCount: number;
  reentrantOwner?: string;
  releaseState: RootSyncHeldLockReleaseState;
  revision: number;
  rootAuthority: FileLockSyncRootAuthority;
  rootPath: FileLockSyncRootPath;
  rootReceipt: FileLockSyncRootFileReceipt;
  snapshot: SidecarLockSnapshot;
  timer?: NodeJS.Timeout;
};

function readRootSyncHeldReleaseState(
  held: RootSyncHeldLock,
): RootSyncHeldLock["releaseState"] {
  return held.releaseState;
}

export function readRootSidecarSnapshotSync(
  rootPath: FileLockSyncRootPath,
  parsePayload?: (raw: string) => unknown,
  onOpenFailure?: (error: unknown) => void,
  expectedReceipt?: FileLockSyncRootFileReceipt,
): FileLockSyncRootSnapshot | null {
  const rawSnapshot = readFileLockSyncRootSnapshot(rootPath, {
    expectedReceipt,
    onOpenFailure,
  });
  if (!rawSnapshot) return null;
  let parsedPayload: unknown;
  try {
    parsedPayload = parseSidecarLockPayload(
      rawSnapshot.snapshot.raw,
      parsePayload,
    );
  } catch (parseError) {
    if (parsePayload) {
      try {
        if (!fileLockSyncRootSnapshotStillCurrent(rootPath, rawSnapshot)) {
          throw new FsSafeError("path-mismatch", "sidecar changed during payload parsing");
        }
      } catch (admissionError) {
        throw createSuppressedError(
          parseError,
          admissionError,
          "sidecar parser and post-callback admission both failed",
        );
      }
    }
    throw parseError;
  }
  if (parsePayload && !fileLockSyncRootSnapshotStillCurrent(rootPath, rawSnapshot)) {
    return null;
  }
  return {
    receipt: rawSnapshot.receipt,
    snapshot: { ...rawSnapshot.snapshot, payload: parsedPayload },
  };
}

export function getRootSyncHeldLocks(): Map<string, RootSyncHeldLock> {
  const globalWithState = globalThis as typeof globalThis & {
    [ROOT_SYNC_HELD_LOCKS_KEY]?: Map<string, RootSyncHeldLock>;
  };
  if (!globalWithState[ROOT_SYNC_HELD_LOCKS_KEY]) {
    globalWithState[ROOT_SYNC_HELD_LOCKS_KEY] = new Map();
  }
  return globalWithState[ROOT_SYNC_HELD_LOCKS_KEY];
}

function existingRootSyncHeldLocks(): Map<string, RootSyncHeldLock> | undefined {
  return (globalThis as typeof globalThis & {
    [ROOT_SYNC_HELD_LOCKS_KEY]?: Map<string, RootSyncHeldLock>;
  })[ROOT_SYNC_HELD_LOCKS_KEY];
}

function reactivateExactHeldLock(
  heldLocks: Map<string, RootSyncHeldLock>,
  held: RootSyncHeldLock,
  restoreConsumedReference: boolean,
): boolean {
  if (heldLocks.get(held.normalizedTargetPath) !== held || held.releaseState === "released") {
    return false;
  }
  if (restoreConsumedReference) held.refCount += 1;
  held.releaseState = "active";
  held.revision += 1;
  return true;
}

function finishDeferredExitReleases(held: RootSyncHeldLock): void {
  const deferred = held.deferredExitReleases;
  if (!deferred) return;
  for (const disposition of deferred) disposition.released = true;
  deferred.clear();
  held.deferredExitReleases = undefined;
}

function restoreDeferredExitReleases(held: RootSyncHeldLock): number {
  const deferred = held.deferredExitReleases;
  if (!deferred) return 0;
  const restored = deferred.size;
  deferred.clear();
  held.deferredExitReleases = undefined;
  return restored;
}

function settleDeferredExitRelease(lock: FileLockSyncHandle): void {
  const disposition = rootSyncHandleDispositions.get(lock);
  if (!disposition || disposition.released) return;
  const deferred = disposition.held.deferredExitReleases;
  // Scoped disposal may surrender only its own reference, after release has
  // proven that exact handle token was tentatively consumed by exit cleanup.
  if (!deferred?.delete(disposition)) return;
  if (deferred.size === 0) disposition.held.deferredExitReleases = undefined;
  disposition.released = true;
}

function restoreExactHeldLockAfterExitCleanup(
  heldLocks: Map<string, RootSyncHeldLock>,
  held: RootSyncHeldLock,
): void {
  if (heldLocks.get(held.normalizedTargetPath) !== held || held.releaseState === "released") return;
  // Restore exactly the handle references tentatively consumed by exit
  // callbacks. A retained successor is a distinct reference and must not be
  // borrowed by a pending original handle.
  held.refCount += restoreDeferredExitReleases(held);
  if (held.refCount <= 0) {
    // No tracked handle can retry. Drop only the record; the sidecar itself is
    // deliberately left in place for policy-governed reclamation.
    held.releaseState = "released";
    held.revision += 1;
    heldLocks.delete(held.normalizedTargetPath);
    return;
  }
  held.releaseState = "active";
  held.revision += 1;
}

function releaseAllRootSyncHeldLocks(): void {
  const globalWithCleanup = globalThis as typeof globalThis & {
    [ROOT_SYNC_CLEANUP_ACTIVE_KEY]?: boolean;
  };
  if (globalWithCleanup[ROOT_SYNC_CLEANUP_ACTIVE_KEY]) return;
  globalWithCleanup[ROOT_SYNC_CLEANUP_ACTIVE_KEY] = true;
  try {
    // A newListener callback can invoke the candidate handler before
    // registration succeeds. Do not create acquisition state in that window.
    const heldLocks = existingRootSyncHeldLocks();
    if (!heldLocks) return;
    for (const [normalizedTargetPath, held] of heldLocks) {
      if (heldLocks.get(normalizedTargetPath) !== held || held.releaseState !== "active") continue;
      held.releaseState = "exit-cleaning";
      held.revision += 1;
      let cleanupRevision = held.revision;
      const timer = held.timer;
      const fd = held.fd;
      // Consume descriptor/timer ownership before either operation can invoke
      // instrumented callbacks or recursively enter the public cleanup hook.
      held.timer = undefined;
      held.fd = undefined;
      if (timer) clearInterval(timer);
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        // Best-effort process-exit cleanup.
      }
      const entryIsContinuous = (): boolean =>
        heldLocks.get(normalizedTargetPath) === held &&
        held.releaseState === "exit-cleaning" &&
        held.revision === cleanupRevision;
      const beginFreshCleanupAttempt = (): void => {
        held.releaseState = "exit-cleaning";
        held.revision += 1;
        cleanupRevision = held.revision;
      };
      if (!entryIsContinuous()) {
        if (heldLocks.get(normalizedTargetPath) === held &&
          readRootSyncHeldReleaseState(held) !== "released" && held.refCount === 0) {
          beginFreshCleanupAttempt();
        } else {
          restoreExactHeldLockAfterExitCleanup(heldLocks, held);
          continue;
        }
      }
      let cleaned = false;
      for (let cleanupAttempt = 0;
        cleanupAttempt < MAX_CONTINUITY_CLEANUP_ATTEMPTS;
        cleanupAttempt += 1) {
        let continuityInterrupted = false;
        let removalFailed = false;
        let removed = false;
        try {
          removed = removeFileLockSyncRootFile(
            held.rootPath,
            held.rootReceipt,
            held.snapshot,
            () => {
              const current = entryIsContinuous();
              if (!current) continuityInterrupted = true;
              return current;
            },
          );
        } catch {
          // A surviving sidecar fails closed and can be reclaimed by policy.
          removalFailed = true;
        }
        if (!removalFailed && removed && !continuityInterrupted && entryIsContinuous()) {
          cleaned = true;
          break;
        }
        const continuousEntry = entryIsContinuous();
        const exactEntry = heldLocks.get(normalizedTargetPath) === held &&
          readRootSyncHeldReleaseState(held) !== "released";
        if (exactEntry && (continuityInterrupted || !continuousEntry) &&
          held.refCount === 0 && cleanupAttempt + 1 < MAX_CONTINUITY_CLEANUP_ATTEMPTS) {
          beginFreshCleanupAttempt();
          continue;
        }
        if (continuousEntry && held.refCount > 0) {
          // Preserve established best-effort process-exit behavior: after
          // authority-safe removal declines or throws, discard the live record
          // without attempting any less-restricted deletion.
          cleaned = true;
          break;
        }
        restoreExactHeldLockAfterExitCleanup(heldLocks, held);
        break;
      }
      if (!cleaned) continue;
      finishDeferredExitReleases(held);
      held.releaseState = "released";
      held.revision += 1;
      if (heldLocks.get(normalizedTargetPath) === held) {
        heldLocks.delete(normalizedTargetPath);
      }
    }
  } finally {
    globalWithCleanup[ROOT_SYNC_CLEANUP_ACTIVE_KEY] = false;
  }
}

export function ensureRootSyncExitCleanupRegistered(): void {
  ensureFileLockSyncRootExitCleanupRegistered(releaseAllRootSyncHeldLocks);
}

export function verifyRootSyncHeldLock(held: RootSyncHeldLock): boolean {
  const current = readRootSidecarSnapshotSync(
    held.rootPath,
    held.parsePayload,
    undefined,
    held.rootReceipt,
  );
  if (!current) return false;
  return current.receipt.identity.dev === held.rootReceipt.identity.dev &&
    current.receipt.identity.ino === held.rootReceipt.identity.ino &&
    sidecarLockSnapshotMatches(current.snapshot, held.snapshot);
}

function releaseRootSyncHeldLock(
  held: RootSyncHeldLock,
  disposition: RootSyncHeldLockHandleDisposition,
): boolean {
  const heldLocks = getRootSyncHeldLocks();
  if (heldLocks.get(held.normalizedTargetPath) !== held || held.releaseState === "released") return true;
  if (held.releaseState !== "active") {
    if (held.deferredExitReleases?.has(disposition)) return false;
    if (held.refCount <= 0) return false;
    if (!fileLockSyncRootReceiptStillCurrent(held.rootPath, held.rootReceipt)) {
      throw new FsSafeError("path-mismatch", "held sidecar lock changed before release");
    }
    held.refCount -= 1;
    held.revision += 1;
    // Exit cleanup, unlike an ordinary final release, has not consumed a
    // handle reference of its own. Keep the last callback-entered handle
    // retryable until cleanup either succeeds or restores it.
    if (held.releaseState !== "exit-cleaning" || held.refCount > 0) return true;
    (held.deferredExitReleases ??= new Set()).add(disposition);
    return false;
  }
  if (held.refCount > 1) {
    if (!fileLockSyncRootReceiptStillCurrent(held.rootPath, held.rootReceipt)) {
      throw new FsSafeError("path-mismatch", "held sidecar lock changed before release");
    }
    held.refCount -= 1;
    held.revision += 1;
    return true;
  }
  if (held.refCount !== 1) return false;
  held.refCount = 0;
  held.releaseState = "releasing";
  held.revision += 1;
  let releaseRevision = held.revision;
  const entryIsContinuous = (): boolean =>
    heldLocks.get(held.normalizedTargetPath) === held &&
    held.releaseState === "releasing" &&
    held.revision === releaseRevision &&
    held.refCount === 0;
  const beginFreshReleaseAttempt = (): void => {
    held.releaseState = "releasing";
    held.revision += 1;
    releaseRevision = held.revision;
  };
  const fd = held.fd;
  held.fd = undefined;
  try {
    if (fd !== undefined) fs.closeSync(fd);
  } catch (error) {
    reactivateExactHeldLock(heldLocks, held, true);
    throw error;
  }
  if (!entryIsContinuous()) {
    if (heldLocks.get(held.normalizedTargetPath) !== held ||
      readRootSyncHeldReleaseState(held) === "released") {
      return true;
    }
    if (held.refCount > 0) {
      reactivateExactHeldLock(heldLocks, held, false);
      return true;
    }
    beginFreshReleaseAttempt();
  }
  for (let releaseAttempt = 0;
    releaseAttempt < MAX_CONTINUITY_CLEANUP_ATTEMPTS;
    releaseAttempt += 1) {
    let continuityInterrupted = false;
    let removed: boolean;
    try {
      removed = removeFileLockSyncRootFile(
        held.rootPath,
        held.rootReceipt,
        held.snapshot,
        () => {
          const current = entryIsContinuous();
          if (!current) continuityInterrupted = true;
          return current;
        },
      );
    } catch (error) {
      reactivateExactHeldLock(heldLocks, held, true);
      throw error;
    }
    if (!continuityInterrupted && entryIsContinuous()) {
      if (!removed) {
        reactivateExactHeldLock(heldLocks, held, true);
        throw new FsSafeError("path-mismatch", "owned sidecar lock changed before release");
      }
      const timer = held.timer;
      held.timer = undefined;
      held.releaseState = "released";
      held.revision += 1;
      if (heldLocks.get(held.normalizedTargetPath) === held) {
        heldLocks.delete(held.normalizedTargetPath);
      }
      if (timer) clearInterval(timer);
      return true;
    }
    if (heldLocks.get(held.normalizedTargetPath) !== held ||
      readRootSyncHeldReleaseState(held) === "released") {
      return true;
    }
    if (held.refCount > 0) {
      reactivateExactHeldLock(heldLocks, held, false);
      return true;
    }
    if (held.refCount === 0 && releaseAttempt + 1 < MAX_CONTINUITY_CLEANUP_ATTEMPTS) {
      beginFreshReleaseAttempt();
      continue;
    }
    reactivateExactHeldLock(heldLocks, held, true);
    throw new FsSafeError("path-mismatch", "held sidecar release continuity changed repeatedly");
  }
  throw new FsSafeError("path-mismatch", "held sidecar release could not complete");
}

export function createRootSyncHeldLockHandle(held: RootSyncHeldLock): FileLockSyncHandle {
  const disposition: RootSyncHeldLockHandleDisposition = { held, released: false };
  let releaseInProgress = false;
  const release = () => {
    if (disposition.released || releaseInProgress) return;
    releaseInProgress = true;
    try {
      if (releaseRootSyncHeldLock(held, disposition)) disposition.released = true;
    } finally {
      releaseInProgress = false;
    }
  };
  const handle: FileLockSyncHandle = {
    lockPath: held.lockPath,
    normalizedTargetPath: held.normalizedTargetPath,
    verifyStillHeld: () => verifyRootSyncHeldLock(held),
    release,
    [Symbol.dispose]: release,
  };
  rootSyncHandleDispositions.set(handle, disposition);
  return handle;
}

export function isRootSyncHeldLockHandle(handle: FileLockSyncHandle): boolean {
  return rootSyncHandleDispositions.has(handle);
}

export function withRootSyncHeldLockHandle<T>(
  lock: FileLockSyncHandle,
  fn: () => T,
): T {
  let result: T;
  try {
    result = fn();
  } catch (callbackError) {
    try {
      lock.release();
      settleDeferredExitRelease(lock);
    } catch (releaseError) {
      throw createSuppressedError(
        releaseError,
        callbackError,
        "file lock release and protected callback both failed",
      );
    }
    throw callbackError;
  }
  lock.release();
  settleDeferredExitRelease(lock);
  return result;
}
