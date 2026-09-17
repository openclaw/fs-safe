import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root, type Root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");
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
  own: boolean;
  value: unknown;
}>;

function countExactExitListener(listener: () => void): number {
  return process.listeners("exit").filter((candidate) => candidate === listener).length;
}

function removeExactExitListeners(listener: unknown): void {
  if (typeof listener !== "function") return;
  while (countExactExitListener(listener as () => void) > 0) {
    process.removeListener("exit", listener as () => void);
  }
}

function isolateRootSyncRegistration(): () => void {
  const snapshots: GlobalSnapshot[] = ISOLATED_KEYS.map((key) => ({
    key,
    own: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: Reflect.get(globalThis, key),
  }));
  const savedHandler = Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY);
  const savedHandlerCount = typeof savedHandler === "function"
    ? countExactExitListener(savedHandler as () => void)
    : 0;
  removeExactExitListeners(savedHandler);
  for (const key of ISOLATED_KEYS) Reflect.deleteProperty(globalThis, key);
  return () => {
    removeExactExitListeners(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY));
    for (const key of ISOLATED_KEYS) Reflect.deleteProperty(globalThis, key);
    for (const snapshot of snapshots) {
      if (snapshot.own) Reflect.set(globalThis, snapshot.key, snapshot.value);
    }
    if (typeof savedHandler === "function") {
      for (let index = 0; index < savedHandlerCount; index += 1) {
        process.on("exit", savedHandler as () => void);
      }
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous Root exit-cleanup registration", () => {
  it("registers only after genuine Root validation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-register-genuine-");
    const genuine = await root(directory);
    const structural = Object.create(genuine) as Root;
    const payload = vi.fn(() => ({ owner: "invalid" }));
    const restore = isolateRootSyncRegistration();
    try {
      expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
        lockRoot: structural,
        payload,
      })).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
      expect(payload).not.toHaveBeenCalled();
      expect(Reflect.has(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.has(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(false);
      expect(Reflect.has(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBe(false);
    } finally {
      restore();
    }
  });

  it("rolls back the exact attempted listener and permits a safe retry", async () => {
    const directory = await tempRoot("fs-safe-sync-root-register-throw-");
    const lockRoot = await root(directory);
    const lockPath = path.join(directory, "missing", "state.lock");
    const target = path.join(directory, "state.json");
    const payload = vi.fn(() => ({ owner: "outer" }));
    const registrationFailure = new Error("newListener rejected cleanup");
    const restore = isolateRootSyncRegistration();
    const baselineExitListeners = process.listeners("exit").length;
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const open = vi.spyOn(fs, "openSync");
    let candidateHandler: (() => void) | undefined;
    let injected = false;
    const rejectRegistration = (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
      if (eventName !== "exit" || injected) return;
      injected = true;
      candidateHandler = listener;
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(true);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBeUndefined();
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
      // Simulate an observer that inserts the candidate and then rejects the
      // original registration. Rollback must remove only this exact listener.
      process.on("exit", listener);
      throw registrationFailure;
    };
    process.on("newListener", rejectRegistration);
    try {
      expect(() => acquireFileLockSync(target, {
        lockPath,
        lockRoot,
        payload,
      })).toThrow(registrationFailure);
      process.removeListener("newListener", rejectRegistration);
      expect(candidateHandler).toBeTypeOf("function");
      expect(countExactExitListener(candidateHandler!)).toBe(0);
      expect(process.listeners("exit")).toHaveLength(baselineExitListeners);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_FAILED_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
      expect(Reflect.has(globalThis, ROOT_SYNC_HELD_LOCKS_KEY)).toBe(false);
      expect(payload).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();

      const retry = acquireFileLockSync(target, { lockPath, lockRoot, payload });
      try {
        const registeredHandler = Reflect.get(
          globalThis,
          ROOT_SYNC_CLEANUP_HANDLER_KEY,
        ) as () => void;
        expect(payload).toHaveBeenCalledTimes(1);
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(true);
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_FAILED_KEY)).toBe(false);
        expect(registeredHandler).toBe(candidateHandler);
        expect(countExactExitListener(registeredHandler)).toBe(1);
        expect(process.listeners("exit")).toHaveLength(baselineExitListeners + 1);
      } finally {
        retry.release();
      }
    } finally {
      process.removeListener("newListener", rejectRegistration);
      restore();
    }
  });

  it("fails reentry while a newListener callback enters the unexposed cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-register-reentry-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "state.json");
    const lockPath = path.join(directory, "state.lock");
    const outerPayload = vi.fn(() => ({ owner: "outer" }));
    const innerPayload = vi.fn(() => ({ owner: "inner" }));
    const restore = isolateRootSyncRegistration();
    const baselineExitListeners = process.listeners("exit").length;
    let candidateHandler: (() => void) | undefined;
    let innerError: unknown;
    let mapPresentDuringCallback: boolean | undefined;
    let registeredDuringCallback: unknown;
    let exposedDuringCallback: unknown;
    const enterCleanup = (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
      if (eventName !== "exit" || candidateHandler) return;
      candidateHandler = listener;
      registeredDuringCallback = Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY);
      exposedDuringCallback = Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY);
      listener();
      mapPresentDuringCallback = Reflect.has(globalThis, ROOT_SYNC_HELD_LOCKS_KEY);
      try {
        acquireFileLockSync(target, {
          lockPath,
          lockRoot,
          payload: innerPayload,
        });
      } catch (error) {
        innerError = error;
      }
    };
    process.on("newListener", enterCleanup);
    let outer: ReturnType<typeof acquireFileLockSync> | undefined;
    try {
      outer = acquireFileLockSync(target, { lockPath, lockRoot, payload: outerPayload });
      process.removeListener("newListener", enterCleanup);
      const registeredHandler = Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY) as () => void;
      expect(candidateHandler).toBe(registeredHandler);
      expect(registeredDuringCallback).toBeUndefined();
      expect(exposedDuringCallback).toBeUndefined();
      expect(mapPresentDuringCallback).toBe(false);
      expect(innerError).toMatchObject({ code: "helper-unavailable" });
      expect(innerPayload).not.toHaveBeenCalled();
      expect(outerPayload).toHaveBeenCalledTimes(1);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(true);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_FAILED_KEY)).toBe(false);
      expect(countExactExitListener(registeredHandler)).toBe(1);
      expect(process.listeners("exit")).toHaveLength(baselineExitListeners + 1);
      expect(outer.verifyStillHeld()).toBe(true);
    } finally {
      process.removeListener("newListener", enterCleanup);
      outer?.release();
      restore();
    }
  });

  it("fails closed with paired errors when exact listener rollback is ambiguous", async () => {
    const directory = await tempRoot("fs-safe-sync-root-register-rollback-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "state.json");
    const payload = vi.fn(() => ({ owner: "outer" }));
    const registrationFailure = new Error("registration failed after insertion");
    const rollbackFailure = new Error("listener rollback result is unknown");
    const restore = isolateRootSyncRegistration();
    const baselineExitListeners = process.listeners("exit").length;
    const realRemoveListener = process.removeListener.bind(process);
    let candidateHandler: (() => void) | undefined;
    let rollbackReentryError: unknown;
    let injected = false;
    const rejectRegistration = (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
      if (eventName !== "exit" || injected) return;
      injected = true;
      candidateHandler = listener;
      process.on("exit", listener);
      throw registrationFailure;
    };
    process.on("newListener", rejectRegistration);
    vi.spyOn(process, "removeListener").mockImplementation((eventName, listener) => {
      if (eventName === "exit" && listener === candidateHandler) {
        try {
          acquireFileLockSync(target, { lockRoot, payload });
        } catch (error) {
          rollbackReentryError = error;
        }
      }
      const result = realRemoveListener(eventName, listener);
      if (eventName === "exit" && listener === candidateHandler) throw rollbackFailure;
      return result;
    });
    try {
      let error: unknown;
      try {
        acquireFileLockSync(target, { lockRoot, payload });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "SuppressedError",
        error: registrationFailure,
        suppressed: rollbackFailure,
      });
      expect(candidateHandler).toBeTypeOf("function");
      expect(countExactExitListener(candidateHandler!)).toBe(0);
      expect(process.listeners("exit")).toHaveLength(baselineExitListeners);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_FAILED_KEY)).toBe(true);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
      expect(rollbackReentryError).toMatchObject({ code: "helper-unavailable" });
      expect(payload).not.toHaveBeenCalled();
      expect(() => acquireFileLockSync(target, { lockRoot, payload })).toThrow(
        expect.objectContaining({ code: "helper-unavailable" }),
      );
      expect(payload).not.toHaveBeenCalled();
    } finally {
      process.removeListener("newListener", rejectRegistration);
      restore();
    }
  });
});
