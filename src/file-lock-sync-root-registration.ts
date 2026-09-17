import { FsSafeError } from "./errors.js";
import { createSuppressedError } from "./suppressed-error.js";

const ROOT_SYNC_CLEANUP_REGISTERING_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupRegistering.v1",
);
const ROOT_SYNC_CLEANUP_REGISTERED_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupRegistered.v1",
);
const ROOT_SYNC_CLEANUP_FAILED_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupRegistrationFailed.v1",
);
const ROOT_SYNC_CLEANUP_HANDLER_KEY = Symbol.for(
  "fsSafe.syncRootSidecarLockCleanupHandler.v1",
);

type RootSyncCleanupRegistrationState = typeof globalThis & {
  [ROOT_SYNC_CLEANUP_REGISTERING_KEY]?: boolean;
  [ROOT_SYNC_CLEANUP_REGISTERED_KEY]?: boolean;
  [ROOT_SYNC_CLEANUP_FAILED_KEY]?: boolean;
  [ROOT_SYNC_CLEANUP_HANDLER_KEY]?: () => void;
};

function unavailable(message: string): FsSafeError {
  return new FsSafeError("helper-unavailable", message);
}

function exactListenerCount(listener: () => void): number {
  return process.listeners("exit").filter((candidate) => candidate === listener).length;
}

export function ensureFileLockSyncRootExitCleanupRegistered(
  cleanupHandler: () => void,
): void {
  const state = globalThis as RootSyncCleanupRegistrationState;
  if (state[ROOT_SYNC_CLEANUP_REGISTERED_KEY]) {
    if (typeof state[ROOT_SYNC_CLEANUP_HANDLER_KEY] === "function") return;
    state[ROOT_SYNC_CLEANUP_FAILED_KEY] = true;
    throw unavailable("Root sidecar exit cleanup registration state is inconsistent");
  }
  if (state[ROOT_SYNC_CLEANUP_FAILED_KEY]) {
    throw unavailable("Root sidecar exit cleanup registration previously failed");
  }
  if (state[ROOT_SYNC_CLEANUP_REGISTERING_KEY]) {
    throw unavailable("Root sidecar exit cleanup registration is already in progress");
  }
  if (state[ROOT_SYNC_CLEANUP_HANDLER_KEY] !== undefined) {
    state[ROOT_SYNC_CLEANUP_FAILED_KEY] = true;
    throw unavailable("Root sidecar exit cleanup handler exists without registration");
  }

  state[ROOT_SYNC_CLEANUP_REGISTERING_KEY] = true;
  let baselineCount: number | undefined;
  let registrationAttempted = false;
  let registrationStateAmbiguous = false;
  try {
    baselineCount = exactListenerCount(cleanupHandler);
    if (baselineCount !== 0) {
      registrationStateAmbiguous = true;
      throw unavailable("Root sidecar exit cleanup listener exists without registration");
    }
    registrationAttempted = true;
    process.on("exit", cleanupHandler);
    if (exactListenerCount(cleanupHandler) !== baselineCount + 1) {
      throw unavailable("Root sidecar exit cleanup listener was not registered exactly once");
    }
    // Do not expose a callable handler or report success until process.on has
    // returned and the exact listener registration has been observed.
    state[ROOT_SYNC_CLEANUP_HANDLER_KEY] = cleanupHandler;
    state[ROOT_SYNC_CLEANUP_REGISTERED_KEY] = true;
    state[ROOT_SYNC_CLEANUP_FAILED_KEY] = false;
    state[ROOT_SYNC_CLEANUP_REGISTERING_KEY] = false;
  } catch (registrationError) {
    let rollbackFailed = false;
    let rollbackError: unknown;
    if (registrationAttempted && baselineCount !== undefined) {
      try {
        let currentCount = exactListenerCount(cleanupHandler);
        while (currentCount > baselineCount) {
          process.removeListener("exit", cleanupHandler);
          const nextCount = exactListenerCount(cleanupHandler);
          if (nextCount >= currentCount) {
            throw unavailable("Root sidecar exit cleanup listener rollback made no progress");
          }
          currentCount = nextCount;
        }
        if (currentCount !== baselineCount) {
          throw unavailable("Root sidecar exit cleanup listener rollback was ambiguous");
        }
      } catch (error) {
        rollbackFailed = true;
        rollbackError = error;
      }
    }

    state[ROOT_SYNC_CLEANUP_HANDLER_KEY] = undefined;
    state[ROOT_SYNC_CLEANUP_REGISTERED_KEY] = false;
    state[ROOT_SYNC_CLEANUP_REGISTERING_KEY] = false;
    if (registrationStateAmbiguous) {
      state[ROOT_SYNC_CLEANUP_FAILED_KEY] = true;
      throw registrationError;
    }
    if (rollbackFailed) {
      state[ROOT_SYNC_CLEANUP_FAILED_KEY] = true;
      throw createSuppressedError(
        registrationError,
        rollbackError,
        "Root sidecar exit cleanup registration and rollback both failed",
      );
    }
    state[ROOT_SYNC_CLEANUP_FAILED_KEY] = false;
    throw registrationError;
  }
}
