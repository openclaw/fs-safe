import fs from "node:fs";
import type { FileLockSyncAcquireOptions } from "./file-lock-sync.js";
import { defaultSyncShouldReclaim, syncLockTimeout } from "./file-lock-sync-admission.js";
import {
  parseSidecarLockSnapshot,
  readSidecarLockRawSnapshotSync,
  removeSidecarLockIfUnchangedSync,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import type { SidecarLockStaleRecovery } from "./sidecar-lock-types.js";

export type SyncStaleOptionsState<TPayload extends Record<string, unknown>> = {
  shouldReclaimObserved?: boolean;
  shouldReclaim?: FileLockSyncAcquireOptions<TPayload>["shouldReclaim"];
  shouldRemoveObserved?: boolean;
  shouldRemove?: FileLockSyncAcquireOptions<TPayload>["shouldRemoveStaleLock"];
};

/** Handle one exclusive-create conflict without surrendering canonical admission. */
export function handleSyncStaleAdmission<TPayload extends Record<string, unknown>>(params: {
  hasToken(): boolean;
  currentHeld(): unknown;
  lockPath: string;
  normalizedTargetPath: string;
  options: FileLockSyncAcquireOptions<TPayload>;
  parsePayload?: (raw: string) => unknown;
  reclaimGuardPath: string;
  retryLockFileDenial(error: unknown): boolean;
  staleMs: number;
  staleOptions: SyncStaleOptionsState<TPayload>;
  staleRecovery?: SidecarLockStaleRecovery;
  waitForRetry(): void;
}): void {
  const holderChanged = {};
  const assertUnheld = () => {
    if (!params.hasToken()) {
      throw syncLockTimeout(params.lockPath, params.normalizedTargetPath);
    }
    if (params.currentHeld()) throw holderChanged;
  };
  const retryHolderChange = (error: unknown): boolean => {
    if (error !== holderChanged) return false;
    params.waitForRetry();
    return true;
  };
  let rawSnapshot: ReturnType<typeof readSidecarLockRawSnapshotSync>;
  let lockFileOpenDenied = false;
  try {
    rawSnapshot = readSidecarLockRawSnapshotSync(params.lockPath, {
      rejectNonFile: true,
      onOpenFailure: (error) => {
        lockFileOpenDenied = true;
        assertUnheld();
      },
    });
    assertUnheld();
  } catch (error) {
    if (retryHolderChange(error)) return;
    try {
      assertUnheld();
    } catch (boundaryError) {
      if (retryHolderChange(boundaryError)) return;
      throw boundaryError;
    }
    if (lockFileOpenDenied && params.retryLockFileDenial(error)) return;
    throw error;
  }
  const stale = params.staleOptions;
  try {
    if (!stale.shouldReclaimObserved) {
      assertUnheld();
      stale.shouldReclaim = params.options.shouldReclaim;
      stale.shouldReclaimObserved = true;
      assertUnheld();
    }
    if (!stale.shouldRemoveObserved) {
      assertUnheld();
      stale.shouldRemove = params.options.shouldRemoveStaleLock;
      stale.shouldRemoveObserved = true;
      assertUnheld();
    }
  } catch (error) {
    if (retryHolderChange(error)) return;
    try {
      assertUnheld();
    } catch (boundaryError) {
      if (retryHolderChange(boundaryError)) return;
      throw boundaryError;
    }
    throw error;
  }
  const guardedParser = params.parsePayload && ((raw: string) => {
    assertUnheld();
    try {
      return Reflect.apply(params.parsePayload!, undefined, [raw]);
    } finally {
      assertUnheld();
    }
  });
  let snapshot: SidecarLockSnapshot | null;
  try {
    snapshot = parseSidecarLockSnapshot(rawSnapshot, guardedParser);
    assertUnheld();
  } catch (error) {
    if (retryHolderChange(error)) return;
    throw error;
  }
  if (!snapshot) {
    params.waitForRetry();
    return;
  }
  const nowMs = Date.now();
  let reclaim: boolean;
  try {
    assertUnheld();
    try {
      reclaim = stale.shouldReclaim
        ? Reflect.apply(stale.shouldReclaim, params.options, [{
            lockPath: params.lockPath,
            normalizedTargetPath: params.normalizedTargetPath,
            payload: snapshot.payload,
            staleMs: params.staleMs,
            nowMs,
            heldByThisProcess: false,
          }])
        : defaultSyncShouldReclaim(snapshot, params.staleMs, nowMs);
    } finally {
      assertUnheld();
    }
  } catch (error) {
    if (retryHolderChange(error)) return;
    throw error;
  }
  if (!reclaim) {
    params.waitForRetry();
    return;
  }
  if (
    params.staleRecovery === "remove-if-unchanged" &&
    snapshot.raw !== undefined &&
    stale.shouldRemove !== undefined
  ) {
    let approved: boolean;
    try {
      assertUnheld();
      try {
        approved = Reflect.apply(stale.shouldRemove, params.options, [{
          lockPath: params.lockPath,
          normalizedTargetPath: params.normalizedTargetPath,
          raw: snapshot.raw,
          payload: snapshot.payload,
        }]);
      } finally {
        assertUnheld();
      }
    } catch (error) {
      if (retryHolderChange(error)) return;
      throw error;
    }
    if (!approved) {
      throw Object.assign(new Error(`file lock stale for ${params.normalizedTargetPath}`), {
        code: "file_lock_stale",
        lockPath: params.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
      });
    }
    try {
      fs.mkdirSync(params.reclaimGuardPath);
    } catch (error) {
      try {
        assertUnheld();
      } catch (boundaryError) {
        if (retryHolderChange(boundaryError)) return;
        throw boundaryError;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        params.waitForRetry();
        return;
      }
      throw error;
    }
    let holderInterrupted = false;
    try {
      assertUnheld();
      if (removeSidecarLockIfUnchangedSync(
        params.lockPath,
        snapshot,
        assertUnheld,
      )) return;
    } catch (error) {
      if (error === holderChanged) holderInterrupted = true;
      else throw error;
    } finally {
      try {
        fs.rmdirSync(params.reclaimGuardPath);
      } catch {
        // A surviving reclaim guard fails closed.
      }
    }
    if (holderInterrupted) {
      params.waitForRetry();
      return;
    }
  }
  throw Object.assign(new Error(`file lock stale for ${params.normalizedTargetPath}`), {
    code: "file_lock_stale",
    lockPath: params.lockPath,
    normalizedTargetPath: params.normalizedTargetPath,
  });
}
