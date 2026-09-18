import fs from "node:fs";
import { foreignSyncHeldLock } from "./file-lock-sync-admission.js";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { FileLockSyncHandle } from "./file-lock-sync.js";
import {
  type FileLockSyncRootAuthority,
  type FileLockSyncRootPath,
} from "./file-lock-sync-root.js";
import type { FileLockSyncRootFileReceipt } from "./file-lock-sync-root-io.js";
import { removeFileLockSyncRootFile } from "./file-lock-sync-root-mutation.js";
import { createSuppressedError } from "./suppressed-error.js";
import {
  createRootSyncHeldLockHandle,
  verifyRootSyncHeldLock,
  type RootSyncHeldLock,
} from "./file-lock-sync-root-held.js";

export class FileLockSyncRootArbitrationCollision extends FsSafeError {
  constructor() {
    super("path-mismatch", "file lock arbitration changed during local creation");
  }
}

export type FileLockSyncRootArbitration = Readonly<{
  authority: FileLockSyncRootAuthority;
  heldLocks: Map<string, RootSyncHeldLock>;
  lockRootPath: FileLockSyncRootPath;
  normalizedTargetPath: string;
  reentrantOwner?: string;
}>;

function sameRootLockPath(left: FileLockSyncRootPath, right: FileLockSyncRootPath): boolean {
  return left.relativePath === right.relativePath && path.relative(left.path, right.path) === "";
}

export function tryReuseCurrentRootSyncHeldLock(
  arbitration: FileLockSyncRootArbitration,
): FileLockSyncHandle | undefined {
  const held = arbitration.heldLocks.get(arbitration.normalizedTargetPath);
  const reusable = held && !foreignSyncHeldLock("root", arbitration.normalizedTargetPath) &&
    arbitration.reentrantOwner !== undefined &&
    held.reentrantOwner !== undefined &&
    arbitration.reentrantOwner === held.reentrantOwner &&
    arbitration.authority.adapter === held.rootAuthority.adapter &&
    sameRootLockPath(arbitration.lockRootPath, held.rootPath) &&
    held.releaseState !== "released";
  if (!reusable) return undefined;
  if (!verifyRootSyncHeldLock(held)) {
    throw new FsSafeError("path-mismatch", "held sidecar lock changed before reentrant reuse");
  }
  // Verification can invoke a custom parser. Re-fetch the exact entry before
  // granting a reference, while retaining supported releasing/exit states.
  if (arbitration.heldLocks.get(arbitration.normalizedTargetPath) !== held ||
    held.releaseState === "released" || foreignSyncHeldLock("root", arbitration.normalizedTargetPath)) {
    throw new FsSafeError("path-mismatch", "held sidecar lock changed during reentrant reuse");
  }
  held.refCount += 1;
  held.revision += 1;
  return createRootSyncHeldLockHandle(held);
}

export function cleanupCreatedRootSyncLock(
  lockRootPath: FileLockSyncRootPath,
  fd: number,
  receipt: FileLockSyncRootFileReceipt,
  timer?: NodeJS.Timeout,
): void {
  let timerCleanupFailed = false;
  let timerCleanupError: unknown;
  try {
    if (timer) clearInterval(timer);
  } catch (error) {
    timerCleanupFailed = true;
    timerCleanupError = error;
  }
  try {
    fs.closeSync(fd);
    if (!removeFileLockSyncRootFile(lockRootPath, receipt)) {
      throw new FsSafeError("path-mismatch", "created sidecar lock changed before cleanup");
    }
  } catch (fileCleanupError) {
    if (timerCleanupFailed) {
      throw createSuppressedError(
        timerCleanupError,
        fileCleanupError,
        "unpublished lock timer and file cleanup both failed",
      );
    }
    throw fileCleanupError;
  }
  if (timerCleanupFailed) throw timerCleanupError;
}
