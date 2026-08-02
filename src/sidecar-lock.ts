import fsSync from "node:fs";
import { sameFileIdentity } from "./file-identity.js";
import {
  removeSidecarLockIfUnchanged,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import { acquireSidecarLock, type HeldSidecarLock } from "./sidecar-lock-acquire.js";
import { createHeldSidecarLockHandle } from "./sidecar-lock-handle.js";
import type {
  SidecarLockAcquireOptions,
  SidecarLockHandle,
  SidecarLockHeldEntry,
  WithSidecarLockOptions,
} from "./sidecar-lock-types.js";
export type { SidecarLockStaleSnapshot } from "./sidecar-lock-reclaim.js";
export type {
  SidecarLockAcquireOptions,
  SidecarLockCompromisedInfo,
  SidecarLockHandle,
  SidecarLockHeldEntry,
  SidecarLockRetryOptions,
  SidecarLockStaleRecovery,
  WithSidecarLockOptions,
} from "./sidecar-lock-types.js";
type SidecarLockManagerState = {
  cleanupRegistered: boolean;
  held: Map<string, HeldSidecarLock>;
  reclaimCleanupRegistered: boolean;
  reclaimGuards: Set<string>;
};
const GLOBAL_STATE_KEY = Symbol.for("fsSafe.sidecarLockManagers");
const GLOBAL_CLEANUP_KEY = Symbol.for("fsSafe.sidecarLockCleanupRegistered");
const GLOBAL_CLEANUP_HANDLER_KEY = Symbol.for("fsSafe.sidecarLockCleanupHandler");
function getGlobalManagers(): Map<string, SidecarLockManagerState> {
  const globalWithState = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: Map<string, SidecarLockManagerState>;
  };
  if (!globalWithState[GLOBAL_STATE_KEY]) {
    globalWithState[GLOBAL_STATE_KEY] = new Map();
  }
  return globalWithState[GLOBAL_STATE_KEY];
}

function resolveManagerState(key: string): SidecarLockManagerState {
  const managers = getGlobalManagers();
  let state = managers.get(key);
  if (!state) {
    state = {
      cleanupRegistered: false,
      held: new Map(),
      reclaimCleanupRegistered: false,
      reclaimGuards: new Set(),
    };
    managers.set(key, state);
  } else {
    // The global manager symbol is shared across package copies and hot reloads.
    // Backfill state created by fs-safe versions that predate reclaim guards.
    state.reclaimCleanupRegistered ??= false;
    state.reclaimGuards ??= new Set();
    for (const held of state.held.values()) {
      held.refCount ??= 1;
    }
  }
  return state;
}

function snapshotMatchesSync(lockPath: string, observed: SidecarLockSnapshot): boolean {
  let fd: number | undefined;
  try {
    const beforeStat = fsSync.lstatSync(lockPath);
    if (!beforeStat.isFile()) {
      return false;
    }
    const openFlags =
      fsSync.constants.O_RDONLY |
      (process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
        ? fsSync.constants.O_NOFOLLOW
        : 0) |
      (typeof fsSync.constants.O_NONBLOCK === "number" ? fsSync.constants.O_NONBLOCK : 0);
    fd = fsSync.openSync(lockPath, openFlags);
    const openedStat = fsSync.fstatSync(fd);
    if (!openedStat.isFile()) {
      return false;
    }
    if (observed.raw !== undefined && openedStat.size !== Buffer.byteLength(observed.raw)) {
      return false;
    }
    const raw = fsSync.readFileSync(fd, "utf8");
    const afterStat = fsSync.lstatSync(lockPath);
    if (!afterStat.isFile() || !sameFileIdentity(beforeStat, afterStat)) {
      return false;
    }
    return sidecarLockSnapshotMatches({ raw, payload: null, stat: afterStat }, observed);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // Best-effort process-exit cleanup.
      }
    }
  }
}

function releaseAllReclaimGuardsSync(state: SidecarLockManagerState): void {
  for (const reclaimGuardPath of state.reclaimGuards) {
    try {
      fsSync.rmdirSync(reclaimGuardPath);
      state.reclaimGuards.delete(reclaimGuardPath);
    } catch {
      // Best-effort process-exit cleanup. A surviving guard fails closed.
    }
  }
}

function releaseAllLocksSync(state: SidecarLockManagerState): void {
  for (const [normalizedTargetPath, held] of state.held) {
    void held.handle.close().catch(() => undefined);
    try {
      if (!held.lockRoot && snapshotMatchesSync(held.lockPath, held.snapshot)) {
        fsSync.rmSync(held.lockPath, { force: true });
      }
    } catch {
      // Best-effort process-exit cleanup.
    }
    state.held.delete(normalizedTargetPath);
  }
  releaseAllReclaimGuardsSync(state);
}

function ensureGlobalExitCleanupRegistered(): void {
  const globalWithCleanup = globalThis as typeof globalThis & {
    [GLOBAL_CLEANUP_KEY]?: boolean;
    [GLOBAL_CLEANUP_HANDLER_KEY]?: () => void;
  };
  if (globalWithCleanup[GLOBAL_CLEANUP_KEY]) return;
  globalWithCleanup[GLOBAL_CLEANUP_KEY] = true;
  const cleanup = () => {
    for (const state of getGlobalManagers().values()) {
      releaseAllLocksSync(state);
    }
  };
  globalWithCleanup[GLOBAL_CLEANUP_HANDLER_KEY] = cleanup;
  process.on("exit", cleanup);
}

async function releaseHeldLock(
  state: SidecarLockManagerState,
  normalizedTargetPath: string,
  held: HeldSidecarLock,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const current = state.held.get(normalizedTargetPath);
  if (current !== held) {
    return false;
  }
  if (options.force) {
    held.refCount = 0;
  } else {
    held.refCount -= 1;
    if (held.refCount > 0) {
      return false;
    }
  }
  if (held.releasePromise) {
    await held.releasePromise.catch(() => undefined);
    return true;
  }
  state.held.delete(normalizedTargetPath);
  if (held.compromiseTimer) {
    clearInterval(held.compromiseTimer);
    held.compromiseTimer = undefined;
  }
  held.releasePromise = (async () => {
    await held.handle.close().catch(() => undefined);
    await removeSidecarLockIfUnchanged(held.lockPath, held.snapshot, {
      lockRoot: held.lockRoot,
      parsePayload: held.parsePayload,
    });
  })();
  try {
    await held.releasePromise;
    return true;
  } finally {
    held.releasePromise = undefined;
  }
}

function handleForHeldLock(
  state: SidecarLockManagerState,
  normalizedTargetPath: string,
  held: HeldSidecarLock,
) {
  return createHeldSidecarLockHandle({
    normalizedTargetPath,
    held,
    release: async () => await releaseHeldLock(state, normalizedTargetPath, held),
  });
}

export function createSidecarLockManager(key: string) {
  const state = resolveManagerState(key);

  function ensureExitCleanupRegistered(): void {
    state.cleanupRegistered = true;
    state.reclaimCleanupRegistered = true;
    ensureGlobalExitCleanupRegistered();
  }

  async function acquire<TPayload extends Record<string, unknown>>(
    options: SidecarLockAcquireOptions<TPayload>,
  ): Promise<SidecarLockHandle> {
    return await acquireSidecarLock(options, {
      held: state.held,
      reclaimGuards: state.reclaimGuards,
      ensureExitCleanupRegistered,
      handleForHeldLock: (normalizedTargetPath, held) =>
        handleForHeldLock(state, normalizedTargetPath, held),
      releaseHeldLock: async (normalizedTargetPath, held, releaseOptions) =>
        await releaseHeldLock(state, normalizedTargetPath, held, releaseOptions),
    });
  }

  async function withLock<T, TPayload extends Record<string, unknown>>(
    options: SidecarLockAcquireOptions<TPayload>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lock = await acquire(options);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  async function drain(): Promise<void> {
    for (const [normalizedTargetPath, held] of Array.from(state.held.entries())) {
      await releaseHeldLock(state, normalizedTargetPath, held, { force: true }).catch(
        () => undefined,
      );
    }
  }

  function reset(): void {
    releaseAllLocksSync(state);
  }

  function heldEntries(): SidecarLockHeldEntry[] {
    return Array.from(state.held.entries()).map(([normalizedTargetPath, held]) => ({
      normalizedTargetPath,
      lockPath: held.lockPath,
      acquiredAt: held.acquiredAt,
      metadata: held.metadata,
      forceRelease: () => releaseHeldLock(state, normalizedTargetPath, held, { force: true }),
    }));
  }

  return { acquire, withLock, drain, reset, heldEntries };
}

export async function withSidecarLock<T, TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: WithSidecarLockOptions<TPayload>,
  fn: () => Promise<T>,
): Promise<T> {
  const manager = createSidecarLockManager(
    options.managerKey ?? `fs-safe.sidecar-lock:${targetPath}`,
  );
  const { managerKey: _managerKey, ...acquireOptions } = options;
  return await manager.withLock({ ...acquireOptions, targetPath }, fn);
}
