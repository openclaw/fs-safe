import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./file-identity.js";
import {
  readSidecarLockSnapshot,
  relativeSidecarLockPath,
  releaseSidecarReclaimGuard,
  removeSidecarLockIfUnchanged,
  removeStaleSidecarLockIfAllowed,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  sidecarLockSnapshotStillPresent,
  sidecarReclaimGuardExists,
  tryAcquireSidecarReclaimGuard,
  type SidecarLockSnapshot,
  type SidecarLockStaleSnapshot,
} from "./sidecar-lock-reclaim.js";
import { FsSafeError } from "./errors.js";
import { createNativeExclusiveFile, type NativeFileHandle } from "./native-operations.js";
import type { Root } from "./root-impl.js";
import type {
  SidecarLockAcquireOptions,
  SidecarLockHandle,
  SidecarLockHeldEntry,
  SidecarLockRetryOptions,
  WithSidecarLockOptions,
} from "./sidecar-lock-types.js";
import {
  computeSidecarLockDelayMs,
  defaultSidecarLockShouldReclaim,
} from "./sidecar-lock-policy.js";
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
type HeldLock = {
  handle: NativeFileHandle;
  lockPath: string;
  snapshot: SidecarLockSnapshot;
  acquiredAt: number;
  metadata: Record<string, unknown>;
  releasePromise?: Promise<void>;
  lockRoot?: Root;
  parsePayload?: (raw: string) => unknown;
  compromiseTimer?: NodeJS.Timeout;
};
type SidecarLockManagerState = {
  cleanupRegistered: boolean;
  held: Map<string, HeldLock>;
  reclaimCleanupRegistered: boolean;
  reclaimGuards: Set<string>;
};
const GLOBAL_STATE_KEY = Symbol.for("fsSafe.sidecarLockManagers");
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

async function resolveNormalizedTargetPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    return path.join(await fs.realpath(dir), path.basename(resolved));
  } catch {
    return resolved;
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

async function releaseHeldLock(
  state: SidecarLockManagerState,
  normalizedTargetPath: string,
  held: HeldLock,
): Promise<boolean> {
  const current = state.held.get(normalizedTargetPath);
  if (current !== held) {
    return false;
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

export function createSidecarLockManager(key: string) {
  const state = resolveManagerState(key);

  function ensureExitCleanupRegistered(): void {
    if (!state.cleanupRegistered) {
      state.cleanupRegistered = true;
      state.reclaimCleanupRegistered = true;
      process.on("exit", () => releaseAllLocksSync(state));
      return;
    }
    if (!state.reclaimCleanupRegistered) {
      state.reclaimCleanupRegistered = true;
      process.on("exit", () => releaseAllReclaimGuardsSync(state));
    }
  }

  async function acquire<TPayload extends Record<string, unknown>>(
    options: SidecarLockAcquireOptions<TPayload>,
  ): Promise<SidecarLockHandle> {
    ensureExitCleanupRegistered();
    const normalizedTargetPath = await resolveNormalizedTargetPath(options.targetPath);
    const lockPath = options.lockPath ?? `${normalizedTargetPath}.lock`;

    const startedAt = Date.now();
    const retry = options.retry ?? {};
    const maxRetries = options.timeoutMs === Number.POSITIVE_INFINITY ? undefined : retry.retries;
    const reclaimGuardPath = `${lockPath}.reclaim`;
    let ownsReclaimGuard = false;
    let attempt = 0;
    const waitForRetry = async (): Promise<void> => {
      const elapsed = Date.now() - startedAt;
      if (
        (options.timeoutMs !== undefined &&
          options.timeoutMs !== Number.POSITIVE_INFINITY &&
          elapsed >= options.timeoutMs) ||
        (maxRetries !== undefined && attempt >= maxRetries)
      ) {
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
      const delay = Math.min(computeSidecarLockDelayMs(retry, attempt), remaining);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    };
    try {
      while (true) {
        if (!ownsReclaimGuard && (await sidecarReclaimGuardExists(reclaimGuardPath))) {
          await waitForRetry();
          continue;
        }
        let handle: NativeFileHandle | null = null;
        try {
          const payload = await options.payload();
          const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
          if (options.lockRoot) {
            const relativeLockPath = relativeSidecarLockPath(options.lockRoot, lockPath);
            try {
              await options.lockRoot.create(relativeLockPath, raw, { mkdir: true, mode: 0o600 });
            } catch (error) {
              if (error instanceof FsSafeError && error.code === "already-exists") {
                throw Object.assign(new Error("sidecar lock exists"), { code: "EEXIST" });
              }
              throw error;
            }
            handle = (await options.lockRoot.open(relativeLockPath)).handle;
          } else {
            handle = (await createNativeExclusiveFile(lockPath, 0o600)) ?? await fs.open(lockPath, "wx");
            await handle.writeFile(raw, "utf8");
          }
          const snapshot = { raw, payload, stat: await handle.stat(), ownershipToken };
          const createdHeld: HeldLock = {
            handle,
            lockPath,
            snapshot,
            acquiredAt: Date.now(),
            metadata: options.metadata ?? {},
            lockRoot: options.lockRoot,
            parsePayload: options.parsePayload,
          };
          state.held.set(normalizedTargetPath, createdHeld);
          if (ownsReclaimGuard) {
            try {
              await releaseSidecarReclaimGuard(state.reclaimGuards, reclaimGuardPath);
              ownsReclaimGuard = false;
            } catch (err) {
              await releaseHeldLock(state, normalizedTargetPath, createdHeld);
              throw err;
            }
          }
          const release = () =>
            releaseHeldLock(state, normalizedTargetPath, createdHeld).then(() => undefined);
          const verifyStillHeld = async () =>
            await sidecarLockSnapshotStillPresent(lockPath, snapshot, {
              lockRoot: options.lockRoot,
              parsePayload: options.parsePayload,
            });
          const interval = options.compromiseCheckIntervalMs;
          if (options.onCompromised && interval !== undefined && interval > 0) {
            createdHeld.compromiseTimer = setInterval(() => {
              void verifyStillHeld().then((stillHeld) => {
                if (!stillHeld && createdHeld.compromiseTimer) {
                  clearInterval(createdHeld.compromiseTimer);
                  createdHeld.compromiseTimer = undefined;
                  options.onCompromised?.({ lockPath, normalizedTargetPath });
                }
              });
            }, interval);
            createdHeld.compromiseTimer.unref();
          }
          return {
            lockPath,
            normalizedTargetPath,
            verifyStillHeld,
            release,
            [Symbol.asyncDispose]: release,
          };
        } catch (err) {
          if (handle) {
            const failedSnapshot: SidecarLockSnapshot = { payload: null };
            try {
              failedSnapshot.stat = await handle.stat();
            } catch {
              // Best-effort cleanup of a failed exclusive create.
            }
            const current = state.held.get(normalizedTargetPath);
            if (current?.handle === handle) {
              state.held.delete(normalizedTargetPath);
            }
            // If payload serialization/write fails, the file may be empty or
            // partial JSON, so remove while our exclusive handle is still open.
            if (!options.lockRoot) {
              await fs.rm(lockPath, { force: true }).catch(() => undefined);
            }
            await handle.close().catch(() => undefined);
            // Windows can refuse removing an open file; retry after close but
            // only if the path still points at the file identity we created.
            await removeSidecarLockIfUnchanged(lockPath, failedSnapshot, {
              lockRoot: options.lockRoot,
              parsePayload: options.parsePayload,
            });
          }
          if ((err as { code?: unknown }).code !== "EEXIST") {
            throw err;
          }
          if (ownsReclaimGuard) {
            await releaseSidecarReclaimGuard(state.reclaimGuards, reclaimGuardPath);
            ownsReclaimGuard = false;
            continue;
          }
          const nowMs = Date.now();
          const snapshot = await readSidecarLockSnapshot(lockPath, {
            lockRoot: options.lockRoot,
            parsePayload: options.parsePayload,
          });
          if (!snapshot) {
            continue;
          }
          const shouldReclaim = options.shouldReclaim ?? defaultSidecarLockShouldReclaim;
          if (
            await shouldReclaim({
              lockPath,
              normalizedTargetPath,
              payload: snapshot?.payload ?? null,
              staleMs: options.staleMs,
              nowMs,
              heldByThisProcess: state.held.has(normalizedTargetPath),
            })
          ) {
            if (
              !(await sidecarLockSnapshotStillPresent(lockPath, snapshot, {
                lockRoot: options.lockRoot,
                parsePayload: options.parsePayload,
              }))
            ) {
              continue;
            }
            const staleRecovery = options.staleRecovery ?? "fail-closed";
            if (staleRecovery === "remove-if-unchanged") {
              if (!(await tryAcquireSidecarReclaimGuard(state.reclaimGuards, reclaimGuardPath))) {
                await waitForRetry();
                continue;
              }
              ownsReclaimGuard = true;
              const removal = await removeStaleSidecarLockIfAllowed({
                lockPath,
                normalizedTargetPath,
                snapshot,
                shouldRemoveStaleLock: options.shouldRemoveStaleLock,
                lockRoot: options.lockRoot,
                parsePayload: options.parsePayload,
              });
              if (removal === "removed" || removal === "changed") {
                continue;
              }
              await releaseSidecarReclaimGuard(state.reclaimGuards, reclaimGuardPath);
              ownsReclaimGuard = false;
            }
            throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
              code: "file_lock_stale",
              lockPath,
              normalizedTargetPath,
            });
          }
          await waitForRetry();
        }
      }
    } finally {
      if (ownsReclaimGuard) {
        await releaseSidecarReclaimGuard(state.reclaimGuards, reclaimGuardPath).catch(
          () => undefined,
        );
      }
    }
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
      await releaseHeldLock(state, normalizedTargetPath, held).catch(
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
      forceRelease: () => releaseHeldLock(state, normalizedTargetPath, held),
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
