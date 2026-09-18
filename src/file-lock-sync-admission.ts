import fs from "node:fs";
import { sidecarLockPayloadCreatedAtMs } from "./sidecar-lock-policy.js";
import type { SidecarLockSnapshot } from "./sidecar-lock-reclaim.js";

export type SyncHeldLock = {
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
const SYNC_ADMISSIONS_KEY = Symbol.for("fsSafe.syncSidecarLockAdmissions");
const SYNC_CLEANUP_REGISTERED_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupRegistered");
const SYNC_CLEANUP_HANDLER_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");
const SYNC_CLEANUP_REGISTRATION_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupRegistration");

const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");

export function foreignSyncHeldLock(route: "raw" | "root", target: string): object | undefined {
  const key = route === "raw" ? ROOT_SYNC_HELD_LOCKS_KEY : SYNC_HELD_LOCKS_KEY;
  const state = globalThis as typeof globalThis & {
    [SYNC_HELD_LOCKS_KEY]?: Map<string, object>;
    [ROOT_SYNC_HELD_LOCKS_KEY]?: Map<string, object>;
  };
  return state[key]?.get(target);
}

export function getSyncHeldLocks(): Map<string, SyncHeldLock> {
  const globalWithState = globalThis as typeof globalThis & {
    [SYNC_HELD_LOCKS_KEY]?: Map<string, SyncHeldLock>;
  };
  if (!globalWithState[SYNC_HELD_LOCKS_KEY]) {
    globalWithState[SYNC_HELD_LOCKS_KEY] = new Map();
  }
  return globalWithState[SYNC_HELD_LOCKS_KEY];
}

export function getSyncLockAdmissions(): Map<string, object> {
  const globalWithState = globalThis as typeof globalThis & {
    [SYNC_ADMISSIONS_KEY]?: Map<string, object>;
  };
  if (!globalWithState[SYNC_ADMISSIONS_KEY]) {
    globalWithState[SYNC_ADMISSIONS_KEY] = new Map();
  }
  return globalWithState[SYNC_ADMISSIONS_KEY];
}

export function syncLockTimeout(lockPath: string, normalizedTargetPath: string): Error {
  return Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
    code: "file_lock_timeout",
    lockPath,
    normalizedTargetPath,
  });
}

export function defaultSyncShouldReclaim(
  snapshot: SidecarLockSnapshot,
  staleMs: number,
  nowMs: number,
): boolean {
  const createdAtMs = sidecarLockPayloadCreatedAtMs(snapshot.payload);
  if (createdAtMs !== null) return nowMs - createdAtMs > staleMs;
  return !snapshot.stat || nowMs - snapshot.stat.mtimeMs > staleMs;
}

export function syncReclaimGuardExists(reclaimGuardPath: string): boolean {
  try {
    fs.lstatSync(reclaimGuardPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function ensureSyncLockExitCleanupRegistered(
  cleanup: () => void,
  lockPath: string,
  normalizedTargetPath: string,
): void {
  const globalWithCleanup = globalThis as typeof globalThis & {
    [SYNC_CLEANUP_REGISTERED_KEY]?: boolean;
    [SYNC_CLEANUP_HANDLER_KEY]?: () => void;
    [SYNC_CLEANUP_REGISTRATION_KEY]?: object;
  };
  if (globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY]) return;
  if (globalWithCleanup[SYNC_CLEANUP_REGISTRATION_KEY]) {
    // process.on() emits newListener synchronously. A nested synchronous
    // acquisition cannot wait for this stack to finish registering.
    throw syncLockTimeout(lockPath, normalizedTargetPath);
  }
  const registration = {};
  globalWithCleanup[SYNC_CLEANUP_REGISTRATION_KEY] = registration;
  try {
    process.on("exit", cleanup);
    globalWithCleanup[SYNC_CLEANUP_HANDLER_KEY] = cleanup;
    globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY] = true;
  } catch (error) {
    if (process.listeners("exit").includes(cleanup)) {
      try {
        process.off("exit", cleanup);
      } catch {
        // Reconcile the marker with the actual listener below.
      }
    }
    if (process.listeners("exit").includes(cleanup)) {
      globalWithCleanup[SYNC_CLEANUP_HANDLER_KEY] = cleanup;
      globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY] = true;
    } else {
      if (globalWithCleanup[SYNC_CLEANUP_HANDLER_KEY] === cleanup) {
        delete globalWithCleanup[SYNC_CLEANUP_HANDLER_KEY];
      }
    }
    throw error;
  } finally {
    if (globalWithCleanup[SYNC_CLEANUP_REGISTRATION_KEY] === registration) {
      delete globalWithCleanup[SYNC_CLEANUP_REGISTRATION_KEY];
    }
  }
}
