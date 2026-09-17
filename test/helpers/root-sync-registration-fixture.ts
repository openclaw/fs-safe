import { createSuppressedError } from "../../src/suppressed-error.js";

export const originalProcessOn = process.on.bind(process) as typeof process.on;
export const originalProcessRemoveListener = process.removeListener.bind(
  process,
) as typeof process.removeListener;

export const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");
export const ROOT_SYNC_CLEANUP_REGISTERING_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupRegistering.v1",
);
export const ROOT_SYNC_CLEANUP_REGISTERED_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupRegistered.v1",
);
export const ROOT_SYNC_CLEANUP_FAILED_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupRegistrationFailed.v1",
);
export const ROOT_SYNC_CLEANUP_HANDLER_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupHandler.v1",
);
const ROOT_SYNC_CLEANUP_ACTIVE_KEY = Symbol.for("fsSafe.syncRootSidecarLockCleanupActive.v1");
const ISOLATED_KEYS = [
  ROOT_SYNC_HELD_LOCKS_KEY,
  ROOT_SYNC_CLEANUP_ACTIVE_KEY,
  ROOT_SYNC_CLEANUP_REGISTERING_KEY,
  ROOT_SYNC_CLEANUP_REGISTERED_KEY,
  ROOT_SYNC_CLEANUP_FAILED_KEY,
  ROOT_SYNC_CLEANUP_HANDLER_KEY,
] as const;

type GlobalSnapshot = Readonly<{
  key: symbol;
  descriptor: PropertyDescriptor | undefined;
}>;

type CapturedFailure = {
  failed: boolean;
  value: unknown;
};

export type ExitListenerOperations = Readonly<{
  count: (listener: () => void) => number;
  remove: (listener: () => void) => void;
}>;

export function countExactExitListener(listener: () => void): number {
  return process.listeners("exit").filter((candidate) => candidate === listener).length;
}

const processExitListenerOperations: ExitListenerOperations = {
  count: countExactExitListener,
  remove: (listener) => { originalProcessRemoveListener("exit", listener); },
};

function captureFailure(state: CapturedFailure, error: unknown, message: string): void {
  state.value = state.failed ? createSuppressedError(error, state.value, message) : error;
  state.failed = true;
}

function listenerCountProgressError(
  phase: string,
  before: number,
  after: number,
  expected = 0,
): Error {
  const bun = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  const runtime = bun ? `Bun ${bun}` : `Node ${process.version}`;
  return new Error(
    `Root sync registration fixture ${phase} made no exit-listener cleanup progress ` +
    `under ${runtime}: before=${before}, after=${after}, expected=${expected}`,
  );
}

export function removeExactExitListeners(
  listener: unknown,
  phase: string,
  operations: ExitListenerOperations = processExitListenerOperations,
): void {
  if (typeof listener !== "function") return;
  const exact = listener as () => void;
  const initial = operations.count(exact);
  let before = initial;
  for (let attempt = 0; attempt < initial && before > 0; attempt += 1) {
    const removal: CapturedFailure = { failed: false, value: undefined };
    try {
      operations.remove(exact);
    } catch (error) {
      captureFailure(removal, error, "exit-listener removal failed");
    }
    const after = operations.count(exact);
    if (after >= before) {
      const progress = listenerCountProgressError(phase, before, after);
      if (removal.failed) {
        throw createSuppressedError(
          removal.value,
          progress,
          "exit-listener removal failed without making progress",
        );
      }
      throw progress;
    }
    before = after;
    if (removal.failed) throw removal.value;
  }
  if (before !== 0) throw listenerCountProgressError(phase, initial, before);
}

export function runCleanupPhases(cleanups: readonly (() => void)[], message: string): void {
  const failure: CapturedFailure = { failed: false, value: undefined };
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      captureFailure(failure, error, message);
    }
  }
  if (failure.failed) throw failure.value;
}

export async function runWithCleanups<T>(
  body: () => T | Promise<T>,
  cleanups: readonly (() => void)[],
): Promise<T> {
  const bodyFailure: CapturedFailure = { failed: false, value: undefined };
  let value: T | undefined;
  try {
    value = await body();
  } catch (error) {
    captureFailure(bodyFailure, error, "registration fixture body failed");
  }
  const cleanupFailure: CapturedFailure = { failed: false, value: undefined };
  try {
    runCleanupPhases(cleanups, "registration fixture cleanups failed");
  } catch (error) {
    captureFailure(cleanupFailure, error, "registration fixture cleanup failed");
  }
  if (cleanupFailure.failed) {
    if (bodyFailure.failed) {
      throw createSuppressedError(
        cleanupFailure.value,
        bodyFailure.value,
        "registration fixture and cleanup both failed",
      );
    }
    throw cleanupFailure.value;
  }
  if (bodyFailure.failed) throw bodyFailure.value;
  return value as T;
}

function snapshotIsolatedGlobals(): GlobalSnapshot[] {
  return ISOLATED_KEYS.map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  }));
}

function clearIsolatedGlobals(phase: string): void {
  runCleanupPhases(ISOLATED_KEYS.map((key) => () => {
    if (!Reflect.deleteProperty(globalThis, key)) {
      throw new Error(`Root sync registration fixture could not clear ${String(key)} during ${phase}`);
    }
  }), `Root sync registration fixture could not clear globals during ${phase}`);
}

function restoreIsolatedGlobals(snapshots: readonly GlobalSnapshot[], phase: string): void {
  runCleanupPhases([
    ...ISOLATED_KEYS.map((key) => () => {
      if (!Reflect.deleteProperty(globalThis, key)) {
        throw new Error(`Root sync registration fixture could not clear ${String(key)} during ${phase}`);
      }
    }),
    ...snapshots.filter(({ descriptor }) => descriptor !== undefined).map(({ key, descriptor }) => () => {
      if (!Reflect.defineProperty(globalThis, key, descriptor!)) {
        throw new Error(`Root sync registration fixture could not restore ${String(key)} during ${phase}`);
      }
    }),
  ], `Root sync registration fixture could not restore globals during ${phase}`);
}

function reconcileExactExitListenerCount(
  listener: unknown,
  expected: number,
  phase: string,
): void {
  if (typeof listener !== "function") {
    if (expected !== 0) throw new Error(`Root sync registration fixture ${phase} lost its saved handler`);
    return;
  }
  const exact = listener as () => void;
  let before = countExactExitListener(exact);
  const failures: CapturedFailure = { failed: false, value: undefined };
  while (before !== expected) {
    const operation: CapturedFailure = { failed: false, value: undefined };
    try {
      if (before > expected) originalProcessRemoveListener("exit", exact);
      else originalProcessOn("exit", exact);
    } catch (error) {
      captureFailure(operation, error, `exit-listener count reconciliation failed during ${phase}`);
    }
    const after = countExactExitListener(exact);
    if (Math.abs(after - expected) >= Math.abs(before - expected)) {
      const progress = listenerCountProgressError(phase, before, after, expected);
      if (operation.failed) {
        captureFailure(
          failures,
          createSuppressedError(operation.value, progress, "listener reconciliation failed without progress"),
          `exit-listener count reconciliation failed during ${phase}`,
        );
      } else {
        captureFailure(failures, progress, `exit-listener count reconciliation failed during ${phase}`);
      }
      break;
    }
    if (operation.failed) {
      captureFailure(failures, operation.value, `exit-listener count reconciliation failed during ${phase}`);
    }
    before = after;
  }
  if (failures.failed) throw failures.value;
}

export function isolateRootSyncRegistration(
  operations: ExitListenerOperations = processExitListenerOperations,
): () => void {
  const snapshots = snapshotIsolatedGlobals();
  const savedHandler = Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY);
  const savedHandlerCount = typeof savedHandler === "function"
    ? countExactExitListener(savedHandler as () => void)
    : 0;
  try {
    removeExactExitListeners(savedHandler, "isolation", operations);
    clearIsolatedGlobals("isolation");
  } catch (isolationFailure) {
    try {
      runCleanupPhases([
        () => restoreIsolatedGlobals(snapshots, "isolation rollback"),
        () => reconcileExactExitListenerCount(savedHandler, savedHandlerCount, "isolation rollback"),
      ], "Root sync registration fixture isolation rollback failed");
    } catch (rollbackFailure) {
      throw createSuppressedError(
        rollbackFailure,
        isolationFailure,
        "Root sync registration fixture isolation and rollback both failed",
      );
    }
    throw isolationFailure;
  }
  return () => runCleanupPhases([
    () => removeExactExitListeners(
      Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY),
      "restoration",
    ),
    () => restoreIsolatedGlobals(snapshots, "restoration"),
    () => reconcileExactExitListenerCount(savedHandler, savedHandlerCount, "restoration"),
  ], "Root sync registration fixture restoration phases failed");
}

export async function withIsolatedRootSyncRegistration<T>(
  body: () => T | Promise<T>,
  beforeRestore: readonly (() => void)[] = [],
): Promise<T> {
  const restore = isolateRootSyncRegistration();
  return runWithCleanups(body, [
    ...beforeRestore,
    restore,
  ]);
}
