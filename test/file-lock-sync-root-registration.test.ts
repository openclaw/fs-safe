import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root, type Root } from "../src/root.js";
import {
  countExactExitListener,
  originalProcessOn,
  originalProcessRemoveListener,
  removeExactExitListeners,
  ROOT_SYNC_CLEANUP_FAILED_KEY,
  ROOT_SYNC_CLEANUP_HANDLER_KEY,
  ROOT_SYNC_CLEANUP_REGISTERED_KEY,
  ROOT_SYNC_CLEANUP_REGISTERING_KEY,
  ROOT_SYNC_HELD_LOCKS_KEY,
  withIsolatedRootSyncRegistration,
} from "./helpers/root-sync-registration-fixture.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous Root exit-cleanup registration", () => {
  it("registers only after genuine Root validation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-register-genuine-");
    const genuine = await root(directory);
    const structural = Object.create(genuine) as Root;
    const payload = vi.fn(() => ({ owner: "invalid" }));
    await withIsolatedRootSyncRegistration(async () => {
      expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
        ...immediate,
        lockRoot: structural,
        payload,
      })).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
      expect(payload).not.toHaveBeenCalled();
      expect(Reflect.has(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.has(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(false);
      expect(Reflect.has(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBe(false);
    });
  });

  it.each([
    ["an Error", new Error("process.on rejected cleanup")],
    ["undefined", undefined],
  ] as const)("rolls back the exact attempted listener and permits a safe retry when registration throws %s", async (
    _failureKind,
    registrationFailure,
  ) => {
    const directory = await tempRoot("fs-safe-sync-root-register-throw-");
    const lockRoot = await root(directory);
    const lockPath = path.join(directory, "missing", "state.lock");
    const target = path.join(directory, "state.json");
    const payload = vi.fn(() => ({ owner: "outer" }));
    let candidateHandler: (() => void) | undefined;
    let retry: ReturnType<typeof acquireFileLockSync> | undefined;
    let restoreProcessOn: (() => void) | undefined;
    let injected = false;
    await withIsolatedRootSyncRegistration(async () => {
      const baselineExitListeners = process.listeners("exit");
      const processOnDescriptor = Object.getOwnPropertyDescriptor(process, "on");
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const open = vi.spyOn(fs, "openSync");
      const processOn = vi.spyOn(process, "on").mockImplementation((eventName, listener) => {
        if (eventName !== "exit" || injected) return originalProcessOn(eventName, listener);
        injected = true;
        candidateHandler = listener as () => void;
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(true);
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBeUndefined();
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
        originalProcessOn(eventName, listener);
        expect(countExactExitListener(candidateHandler)).toBe(1);
        throw registrationFailure;
      });
      restoreProcessOn = () => { processOn.mockRestore(); };
      let acquisitionThrew = false;
      let acquisitionError: unknown;
      try {
        acquireFileLockSync(target, {
          ...immediate,
          lockPath,
          lockRoot,
          payload,
        });
      } catch (error) {
        acquisitionThrew = true;
        acquisitionError = error;
      }
      expect(acquisitionThrew).toBe(true);
      expect(acquisitionError).toBe(registrationFailure);
      restoreProcessOn();
      restoreProcessOn = undefined;
      expect(Object.getOwnPropertyDescriptor(process, "on")).toEqual(processOnDescriptor);
      expect(injected).toBe(true);
      expect(candidateHandler).toBeTypeOf("function");
      expect(countExactExitListener(candidateHandler!)).toBe(0);
      expect(process.listeners("exit")).toEqual(baselineExitListeners);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_FAILED_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
      expect(Reflect.has(globalThis, ROOT_SYNC_HELD_LOCKS_KEY)).toBe(false);
      expect(payload).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();

      retry = acquireFileLockSync(target, { ...immediate, lockPath, lockRoot, payload });
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
      expect(process.listeners("exit")).toEqual([...baselineExitListeners, registeredHandler]);
      expect(retry.verifyStillHeld()).toBe(true);
    }, [
      () => { restoreProcessOn?.(); },
      () => { retry?.release(); },
      () => removeExactExitListeners(candidateHandler, "retry candidate cleanup"),
    ]);
  });

  it("fails reentry while a newListener callback enters the unexposed cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-register-reentry-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "state.json");
    const lockPath = path.join(directory, "state.lock");
    const outerPayload = vi.fn(() => ({ owner: "outer" }));
    const innerPayload = vi.fn(() => ({ owner: "inner" }));
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
          ...immediate,
          lockPath,
          lockRoot,
          payload: innerPayload,
        });
      } catch (error) {
        innerError = error;
      }
    };
    let outer: ReturnType<typeof acquireFileLockSync> | undefined;
    await withIsolatedRootSyncRegistration(async () => {
      const baselineExitListeners = process.listeners("exit").length;
      process.on("newListener", enterCleanup);
      outer = acquireFileLockSync(target, {
        ...immediate,
        lockPath,
        lockRoot,
        payload: outerPayload,
      });
      originalProcessRemoveListener("newListener", enterCleanup);
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
    }, [
      () => { originalProcessRemoveListener("newListener", enterCleanup); },
      () => { outer?.release(); },
      () => removeExactExitListeners(candidateHandler, "reentry candidate cleanup"),
    ]);
  });

  it.each([
    ["an Error", new Error("listener rollback result is unknown")],
    ["undefined", undefined],
  ] as const)("fails closed when exact listener rollback throws %s", async (
    _failureKind,
    rollbackFailure,
  ) => {
    const directory = await tempRoot("fs-safe-sync-root-register-rollback-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "state.json");
    const payload = vi.fn(() => ({ owner: "outer" }));
    const registrationFailure = new Error("registration failed after insertion");
    let candidateHandler: (() => void) | undefined;
    let rollbackReentryError: unknown;
    let restoreProcessOn: (() => void) | undefined;
    let restoreProcessRemoveListener: (() => void) | undefined;
    let injected = false;
    await withIsolatedRootSyncRegistration(async () => {
      const baselineExitListeners = process.listeners("exit");
      const processOnDescriptor = Object.getOwnPropertyDescriptor(process, "on");
      const processRemoveListenerDescriptor = Object.getOwnPropertyDescriptor(process, "removeListener");
      const mkdir = vi.spyOn(fs, "mkdirSync");
      const open = vi.spyOn(fs, "openSync");
      const processOn = vi.spyOn(process, "on").mockImplementation((eventName, listener) => {
        if (eventName !== "exit" || injected) return originalProcessOn(eventName, listener);
        injected = true;
        candidateHandler = listener as () => void;
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(true);
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBeUndefined();
        expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
        originalProcessOn(eventName, listener);
        expect(countExactExitListener(candidateHandler)).toBe(1);
        throw registrationFailure;
      });
      restoreProcessOn = () => { processOn.mockRestore(); };
      const processRemoveListener = vi.spyOn(process, "removeListener").mockImplementation((
        eventName,
        listener,
      ) => {
        if (eventName === "exit" && listener === candidateHandler) {
          expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(true);
          expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBeUndefined();
          expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
          try {
            acquireFileLockSync(target, { ...immediate, lockRoot, payload });
          } catch (error) {
            rollbackReentryError = error;
          }
          originalProcessRemoveListener(eventName, listener);
          expect(countExactExitListener(candidateHandler!)).toBe(0);
          throw rollbackFailure;
        }
        return originalProcessRemoveListener(eventName, listener);
      });
      restoreProcessRemoveListener = () => { processRemoveListener.mockRestore(); };
      let acquisitionThrew = false;
      let acquisitionError: unknown;
      try {
        acquireFileLockSync(target, { ...immediate, lockRoot, payload });
      } catch (caught) {
        acquisitionThrew = true;
        acquisitionError = caught;
      }
      restoreProcessRemoveListener();
      restoreProcessRemoveListener = undefined;
      restoreProcessOn();
      restoreProcessOn = undefined;
      expect(Object.getOwnPropertyDescriptor(process, "removeListener"))
        .toEqual(processRemoveListenerDescriptor);
      expect(Object.getOwnPropertyDescriptor(process, "on")).toEqual(processOnDescriptor);
      expect(acquisitionThrew).toBe(true);
      expect(acquisitionError).toMatchObject({ name: "SuppressedError" });
      expect((acquisitionError as { error: unknown }).error).toBe(registrationFailure);
      expect(Object.hasOwn(acquisitionError as object, "suppressed")).toBe(true);
      expect((acquisitionError as { suppressed: unknown }).suppressed).toBe(rollbackFailure);
      expect(injected).toBe(true);
      expect(candidateHandler).toBeTypeOf("function");
      expect(countExactExitListener(candidateHandler!)).toBe(0);
      expect(process.listeners("exit")).toEqual(baselineExitListeners);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERING_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(false);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_FAILED_KEY)).toBe(true);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBeUndefined();
      expect(rollbackReentryError).toMatchObject({ code: "helper-unavailable" });
      expect(payload).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(() => acquireFileLockSync(target, { ...immediate, lockRoot, payload })).toThrow(
        expect.objectContaining({ code: "helper-unavailable" }),
      );
      expect(payload).not.toHaveBeenCalled();
    }, [
      () => { restoreProcessRemoveListener?.(); },
      () => { restoreProcessOn?.(); },
      () => removeExactExitListeners(candidateHandler, "rollback candidate cleanup"),
    ]);
  });
});
