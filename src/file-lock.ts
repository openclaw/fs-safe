import {
  createSidecarLockManager,
  type SidecarLockAcquireOptions,
  type SidecarLockHandle,
  type SidecarLockHeldEntry,
  type SidecarLockRetryOptions,
  type SidecarLockStaleRecovery,
} from "./sidecar-lock.js";
import { getFsSafeLockConfig } from "./lock-config.js";
export {
  acquireFileLockSync,
  withFileLockSync,
  type FileLockSyncAcquireOptions,
  type FileLockSyncHandle,
} from "./file-lock-sync.js";

export type FileLockRetryOptions = SidecarLockRetryOptions;
export type FileLockStaleRecovery = SidecarLockStaleRecovery;

export type FileLockAcquireOptions<TPayload extends Record<string, unknown>> = Omit<
  SidecarLockAcquireOptions<TPayload>,
  "targetPath" | "staleMs"
> & {
  managerKey?: string;
  staleMs?: number;
};

export type FileLockHandle = SidecarLockHandle;
export type FileLockHeldEntry = SidecarLockHeldEntry;
export type { SidecarLockCompromisedInfo } from "./sidecar-lock.js";

export type FileLockManager = {
  acquire<TPayload extends Record<string, unknown>>(
    targetPath: string,
    options: FileLockAcquireOptions<TPayload>,
  ): Promise<FileLockHandle>;
  withLock<T, TPayload extends Record<string, unknown>>(
    targetPath: string,
    options: FileLockAcquireOptions<TPayload>,
    fn: () => Promise<T>,
  ): Promise<T>;
  drain(): Promise<void>;
  reset(): void;
  heldEntries(): FileLockHeldEntry[];
};

function resolveFileLockManagerKey(targetPath: string, managerKey?: string): string {
  return managerKey ?? `fs-safe.file-lock:${targetPath}`;
}

function withLockDefaults<TPayload extends Record<string, unknown>>(
  options: FileLockAcquireOptions<TPayload>,
): Omit<SidecarLockAcquireOptions<TPayload>, "targetPath"> {
  const { managerKey: _managerKey, lockPath } = options;
  const acquireOptions = {} as FileLockAcquireOptions<TPayload>;
  for (const key of Reflect.ownKeys(options)) {
    // Node 22 object-rest can read excluded accessors; exclude before copying.
    if (key === "managerKey" || key === "lockPath") continue;
    if (!Object.getOwnPropertyDescriptor(options, key)?.enumerable) continue;
    Object.defineProperty(acquireOptions, key, {
      value: Reflect.get(options, key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const defaults = getFsSafeLockConfig();
  return {
    ...acquireOptions,
    retry: acquireOptions.retry ?? defaults.retry,
    staleMs: acquireOptions.staleMs ?? defaults.staleMs ?? 30_000,
    staleRecovery: acquireOptions.staleRecovery ?? defaults.staleRecovery,
    timeoutMs: acquireOptions.timeoutMs ?? defaults.timeoutMs,
    ...(lockPath === undefined ? {} : { lockPath }),
  };
}

export async function acquireFileLock<TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockAcquireOptions<TPayload>,
): Promise<FileLockHandle> {
  return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey))
    .acquire(targetPath, options);
}

export async function withFileLock<T, TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockAcquireOptions<TPayload>,
  fn: () => Promise<T>,
): Promise<T> {
  return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey))
    .withLock(targetPath, options, fn);
}

export function createFileLockManager(key: string): FileLockManager {
  const manager = createSidecarLockManager(key);
  return {
    acquire: async (targetPath, options) => {
      return await manager.acquire({
        ...withLockDefaults(options),
        targetPath,
      });
    },
    withLock: async (targetPath, options, fn) => {
      return await manager.withLock({
        ...withLockDefaults(options),
        targetPath,
      }, fn);
    },
    drain: manager.drain,
    reset: manager.reset,
    heldEntries: manager.heldEntries,
  };
}

export async function drainFileLockManagerForTest(
  targetPath: string,
  managerKey?: string,
): Promise<void> {
  await createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).drain();
}

export function resetFileLockManagerForTest(targetPath: string, managerKey?: string): void {
  createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).reset();
}
