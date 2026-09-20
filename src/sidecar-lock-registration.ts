type CleanupRegistration = {
  event: "exit" | "beforeExit";
  registered: symbol;
  registering: symbol;
  handler: symbol;
  retainAware?: symbol;
  reentryError(): Error;
};

/** Preserve the legacy, first-registration-wins protocol across package copies. */
export function ensureSidecarLockCleanupRegistered<T extends true | { armed: boolean }>(
  keys: CleanupRegistration,
  cleanup: () => void,
  marker: T,
): T {
  const state = globalThis as Record<symbol, unknown>;
  if (state[keys.registered]) return state[keys.registered] as T;
  // process.on emits newListener synchronously; reentry cannot wait for it.
  if (state[keys.registering]) throw keys.reentryError();
  const registration = {};
  const commit = () => {
    state[keys.handler] = cleanup;
    if (keys.retainAware) state[keys.retainAware] = true;
    state[keys.registered] = marker;
  };
  state[keys.registering] = registration;
  try {
    process.on(keys.event, cleanup);
    commit();
    return marker;
  } catch (error) {
    if (process.listeners(keys.event).includes(cleanup)) {
      try {
        process.off(keys.event, cleanup);
      } catch {
        // Reconcile the marker with the actual listener below.
      }
    }
    if (process.listeners(keys.event).includes(cleanup)) {
      commit();
    } else {
      if (state[keys.handler] === cleanup) delete state[keys.handler];
      // Only the before-exit lifecycle has an individually owned marker.
      if (marker !== true && state[keys.registered] === marker) delete state[keys.registered];
    }
    throw error;
  } finally {
    if (state[keys.registering] === registration) delete state[keys.registering];
  }
}
