import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");
const asyncCleanupKey = Symbol.for("fsSafe.sidecarLockCleanupRegistered");
const asyncCleanupHandlerKey = Symbol.for("fsSafe.sidecarLockCleanupHandler");
const asyncCleanupRegistrationKey = Symbol.for("fsSafe.sidecarLockCleanupRegistration");
const beforeExitKey = Symbol.for("fsSafe.sidecarLockBeforeExitCleanup");
const beforeExitHandlerKey = Symbol.for("fsSafe.sidecarLockBeforeExitCleanupHandler");
const beforeExitRegistrationKey = Symbol.for("fsSafe.sidecarLockBeforeExitCleanupRegistration");
const retainAwareKey = Symbol.for("fsSafe.sidecarLockRetainAwareCleanup");
const syncHeldKey = Symbol.for("fsSafe.syncSidecarLocks");
const syncAdmissionsKey = Symbol.for("fsSafe.syncSidecarLockAdmissions");
const syncCleanupKey = Symbol.for("fsSafe.syncSidecarLockCleanupRegistered");
const syncCleanupHandlerKey = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");
const syncCleanupRegistrationKey = Symbol.for("fsSafe.syncSidecarLockCleanupRegistration");

type ManagerState = {
  held: Map<string, unknown>;
  admissions: Map<string, object>;
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function managerState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, managersKey) as Map<string, ManagerState>;
  return managers.get(key)!;
}

function removeGlobalHandler(eventName: "exit" | "beforeExit", key: symbol): void {
  const handler = Reflect.get(globalThis, key) as (() => void) | undefined;
  if (handler && process.listeners(eventName).includes(handler)) process.off(eventName, handler);
  Reflect.deleteProperty(globalThis, key);
}

function clearAsyncCleanupRegistration(): void {
  removeGlobalHandler("exit", asyncCleanupHandlerKey);
  removeGlobalHandler("beforeExit", beforeExitHandlerKey);
  for (const key of [
    asyncCleanupKey,
    asyncCleanupRegistrationKey,
    beforeExitKey,
    beforeExitRegistrationKey,
    retainAwareKey,
  ]) Reflect.deleteProperty(globalThis, key);
}

function resetCleanupRegistration(): void {
  clearAsyncCleanupRegistration();
  removeGlobalHandler("exit", syncCleanupHandlerKey);
  for (const key of [
    syncCleanupKey,
    syncCleanupRegistrationKey,
  ]) Reflect.deleteProperty(globalThis, key);
  (Reflect.get(globalThis, syncHeldKey) as Map<string, unknown> | undefined)?.clear();
  (Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object> | undefined)?.clear();
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
  resetCleanupRegistration();
});

describe("sidecar-lock cleanup registration transactions", () => {
  it.each([
    ["exit", false],
    ["exit", true],
    ["beforeExit", false],
    ["beforeExit", true],
  ] as const)(
    "rolls back async %s registration when process.on %s adding its listener",
    async (eventName, afterAdd) => {
      resetCleanupRegistration();
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-${eventName}-${afterAdd}-`);
      const target = path.join(directory, "state.json");
      const key = `registration:${eventName}:${afterAdd}:${directory}`;
      const manager = createSidecarLockManager(key);
      const payload = vi.fn(async () => ({ owner: "candidate" }));
      const failure = new Error(`${eventName} listener rejected`);
      const handlerKey = eventName === "exit" ? asyncCleanupHandlerKey : beforeExitHandlerKey;
      const markerKey = eventName === "exit" ? asyncCleanupKey : beforeExitKey;
      const registrationKey = eventName === "exit"
        ? asyncCleanupRegistrationKey
        : beforeExitRegistrationKey;
      const listenersBefore = process.listenerCount(eventName);
      const realOn = process.on;
      const on = vi.spyOn(process, "on");
      on.mockImplementation((function (this: NodeJS.Process, candidateEvent, listener) {
        if (candidateEvent !== eventName) {
          return Reflect.apply(realOn, this, [candidateEvent, listener]);
        }
        if (afterAdd) Reflect.apply(realOn, this, [candidateEvent, listener]);
        throw failure;
      }) as typeof process.on);

      await expect(manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        payload,
      })).rejects.toBe(failure);
      expect(payload).not.toHaveBeenCalled();
      expect(process.listenerCount(eventName)).toBe(listenersBefore);
      expect(Reflect.get(globalThis, handlerKey)).toBeUndefined();
      expect(Reflect.get(globalThis, markerKey)).toBeUndefined();
      expect(Reflect.get(globalThis, registrationKey)).toBeUndefined();
      if (eventName === "exit") expect(Reflect.get(globalThis, retainAwareKey)).toBeUndefined();
      expect(managerState(key).admissions.size).toBe(0);
      expect(managerState(key).held.size).toBe(0);
      await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

      on.mockRestore();
      const retry = await manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        payload: async () => ({ owner: "retry" }),
      });
      await retry.release();
    },
  );

  it.each(["exit", "beforeExit"] as const)(
    "reconciles async %s registration when the added listener cannot be rolled back",
    async (eventName) => {
      resetCleanupRegistration();
      const directory = await tempRoot(`fs-safe-async-${eventName}-retained-listener-`);
      const target = path.join(directory, "state.json");
      const key = `retained-registration:${eventName}:${directory}`;
      const manager = createSidecarLockManager(key);
      const failure = new Error(`${eventName} listener rejected after add`);
      const rollbackFailure = new Error(`${eventName} listener removal rejected`);
      const handlerKey = eventName === "exit" ? asyncCleanupHandlerKey : beforeExitHandlerKey;
      const markerKey = eventName === "exit" ? asyncCleanupKey : beforeExitKey;
      const registrationKey = eventName === "exit"
        ? asyncCleanupRegistrationKey
        : beforeExitRegistrationKey;
      const listenersBefore = process.listenerCount(eventName);
      const realOn = process.on;
      const realOff = process.off;
      const on = vi.spyOn(process, "on");
      on.mockImplementation((function (this: NodeJS.Process, candidateEvent, listener) {
        const result = Reflect.apply(realOn, this, [candidateEvent, listener]);
        if (candidateEvent === eventName) throw failure;
        return result;
      }) as typeof process.on);
      const off = vi.spyOn(process, "off");
      off.mockImplementation((function (this: NodeJS.Process, candidateEvent, listener) {
        if (candidateEvent === eventName) throw rollbackFailure;
        return Reflect.apply(realOff, this, [candidateEvent, listener]);
      }) as typeof process.off);

      await expect(manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        payload: async () => ({ owner: "candidate" }),
      })).rejects.toBe(failure);
      expect(process.listenerCount(eventName)).toBe(listenersBefore + 1);
      expect(Reflect.get(globalThis, handlerKey)).toBeTypeOf("function");
      expect(Reflect.get(globalThis, markerKey)).toBeTruthy();
      expect(Reflect.get(globalThis, registrationKey)).toBeUndefined();
      expect(managerState(key).admissions.size).toBe(0);
      expect(managerState(key).held.size).toBe(0);

      on.mockRestore();
      off.mockRestore();
      const retry = await manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        payload: async () => ({ owner: "retry" }),
      });
      await retry.release();
    },
  );

  it.each(["sync", "async"] as const)(
    "rolls back %s admission when compromise timer unref throws",
    async (mode) => {
      resetCleanupRegistration();
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-${mode}-unref-`);
      const target = path.join(directory, "state.json");
      const failure = new Error("timer unref failed");
      const timer = { unref: () => { throw failure; } } as unknown as NodeJS.Timeout;
      vi.spyOn(globalThis, "setInterval").mockReturnValueOnce(timer);
      const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

      if (mode === "sync") {
        expect(() => acquireFileLockSync(target, {
          payload: () => ({ owner: "candidate" }),
          compromiseCheckIntervalMs: 1,
          onCompromised: () => undefined,
        })).toThrow(failure);
        expect((Reflect.get(globalThis, syncHeldKey) as Map<string, unknown>).size).toBe(0);
        expect((Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>).size).toBe(0);
      } else {
        const key = `unref:${directory}`;
        const manager = createSidecarLockManager(key);
        await expect(manager.acquire({
          targetPath: target,
          staleMs: 30_000,
          payload: async () => ({ owner: "candidate" }),
          compromiseCheckIntervalMs: 1,
          onCompromised: () => undefined,
        })).rejects.toBe(failure);
        expect(managerState(key).held.size).toBe(0);
        expect(managerState(key).admissions.size).toBe(0);
        expect(Reflect.get(globalThis, beforeExitKey)).toMatchObject({ armed: false });
      }
      expect(clear).toHaveBeenCalledWith(timer);
      await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rearms Root cleanup after a manual beforeExit during async admission", async () => {
    resetCleanupRegistration();
    const directory = await tempRoot("fs-safe-before-exit-admission-");
    const capability = await root(directory);
    const target = path.join(directory, "state.json");
    const key = `before-exit-admission:${directory}`;
    const manager = createSidecarLockManager(key);
    let duringAdmission = 0;
    const options = {
      targetPath: target,
      staleMs: 30_000,
      lockRoot: capability,
      compromiseCheckIntervalMs: 1,
      payload: async () => ({ owner: "candidate" }),
      get onCompromised() {
        duringAdmission += 1;
        const lifecycle = Reflect.get(globalThis, beforeExitKey) as { armed: boolean };
        const cleanup = Reflect.get(globalThis, beforeExitHandlerKey) as () => void;
        expect(lifecycle.armed).toBe(false);
        expect(manager.heldEntries()).toHaveLength(0);
        cleanup();
        return undefined;
      },
    };

    const lock = await manager.acquire(options);
    expect(duringAdmission).toBe(1);
    const lifecycle = Reflect.get(globalThis, beforeExitKey) as { armed: boolean };
    expect(lifecycle.armed).toBe(true);
    const cleanup = Reflect.get(globalThis, beforeExitHandlerKey) as () => void;
    cleanup();
    await vi.waitFor(() => expect(manager.heldEntries()).toHaveLength(0), { timeout: 5_000 });
    expect(lifecycle.armed).toBe(false);
    await expect(fs.access(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when synchronous exit cleanup runs before publication", async () => {
    resetCleanupRegistration();
    const directory = await tempRoot("fs-safe-sync-exit-admission-");
    const target = path.join(directory, "state.json");
    const timer = {
      unref() {
        const cleanup = Reflect.get(globalThis, syncCleanupHandlerKey) as () => void;
        cleanup();
      },
    } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockReturnValueOnce(timer);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    expect(() => acquireFileLockSync(target, {
      payload: () => ({ owner: "candidate" }),
      timeoutMs: 0,
      retry: { retries: 0 },
      compromiseCheckIntervalMs: 1,
      onCompromised: () => undefined,
    })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(fsSync.existsSync(`${target}.lock`)).toBe(false);
    expect((Reflect.get(globalThis, syncHeldKey) as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>).size).toBe(0);
  });

  it("revalidates retainOnExit when a legacy registration wins during target resolution", async () => {
    resetCleanupRegistration();
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-legacy-retain-scheduled-");
    const capability = await root(directory);
    const target = path.join(directory, "state.json");
    const key = `legacy-retain-scheduled:${directory}`;
    const manager = createSidecarLockManager(key);
    const entered = deferred();
    const resume = deferred();
    const resolve = capability.resolve.bind(capability);
    let firstResolve = true;
    vi.spyOn(capability, "resolve").mockImplementation(async (relativePath) => {
      if (firstResolve) {
        firstResolve = false;
        entered.resolve();
        await resume.promise;
      }
      return await resolve(relativePath);
    });
    const payload = vi.fn(async () => ({ owner: "candidate" }));
    const acquiring = manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockRoot: capability,
      retainOnExit: true,
      payload,
    });
    await entered.promise;
    const legacyCleanup = () => undefined;
    process.on("exit", legacyCleanup);
    Reflect.set(globalThis, asyncCleanupHandlerKey, legacyCleanup);
    Reflect.set(globalThis, asyncCleanupKey, true);
    Reflect.deleteProperty(globalThis, retainAwareKey);
    resume.resolve();
    try {
      await expect(acquiring).rejects.toMatchObject({ code: "helper-unavailable" });
      expect(payload).not.toHaveBeenCalled();
      expect(managerState(key).admissions.size).toBe(0);
      expect(managerState(key).held.size).toBe(0);
      await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (process.listeners("exit").includes(legacyCleanup)) process.off("exit", legacyCleanup);
      if (Reflect.get(globalThis, asyncCleanupHandlerKey) === legacyCleanup) {
        Reflect.deleteProperty(globalThis, asyncCleanupHandlerKey);
      }
    }
  });

  it.each(["reset", "exit", "release"] as const)(
    "rechecks a completed owner after registration triggers %s",
    async (action) => {
      resetCleanupRegistration();
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-owner-registration-${action}-`);
      const target = path.join(directory, "state.json");
      const key = `owner-registration:${action}:${directory}`;
      const manager = createSidecarLockManager(key);
      const ownerOptions = {
        targetPath: target,
        staleMs: 30_000,
        reentrantOwner: "owner",
      };
      const first = await manager.acquire({
        ...ownerOptions,
        payload: async () => ({ owner: "first" }),
      });
      const exitCleanup = Reflect.get(globalThis, asyncCleanupHandlerKey) as () => void;
      clearAsyncCleanupRegistration();
      let releasePromise: Promise<void> | undefined;
      let fired = false;
      const onNewListener = (eventName: string | symbol) => {
        if (eventName !== "exit" || fired) return;
        fired = true;
        if (action === "reset") manager.reset();
        else if (action === "exit") exitCleanup();
        else releasePromise = first.release();
      };
      process.on("newListener", onNewListener);
      const payload = vi.fn(async () => ({ owner: "replacement" }));
      let replacement: typeof first | undefined;
      try {
        replacement = await manager.acquire({ ...ownerOptions, payload });
        await releasePromise;
        expect(fired).toBe(true);
        expect(payload).toHaveBeenCalledOnce();
        expect(managerState(key).held.size).toBe(1);
        expect(await replacement.verifyStillHeld()).toBe(true);
      } finally {
        process.off("newListener", onNewListener);
        await releasePromise?.catch(() => undefined);
        await replacement?.release().catch(() => undefined);
        await first.release().catch(() => undefined);
      }
    },
  );
});
