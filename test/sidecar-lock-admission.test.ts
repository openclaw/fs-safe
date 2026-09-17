import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
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
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function managerState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
    string,
    ManagerState
  >;
  return managers.get(key)!;
}

function syncAdmissions(): Map<string, object> {
  return Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>;
}

function resetSyncCleanupRegistration(): void {
  const handler = Reflect.get(globalThis, syncCleanupHandlerKey) as (() => void) | undefined;
  handler?.();
  if (handler && process.listeners("exit").includes(handler)) process.off("exit", handler);
  Reflect.deleteProperty(globalThis, syncCleanupKey);
  Reflect.deleteProperty(globalThis, syncCleanupHandlerKey);
  Reflect.deleteProperty(globalThis, syncCleanupRegistrationKey);
  (Reflect.get(globalThis, syncHeldKey) as Map<string, unknown> | undefined)?.clear();
  (Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object> | undefined)?.clear();
}

function syncOptions(payload: () => Record<string, unknown>) {
  return { payload, timeoutMs: 0, retry: { retries: 0 } } as const;
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
  resetSyncCleanupRegistration();
});

describe("transactional sidecar-lock admission", () => {
  it.each(["payload", "toJSON"] as const)(
    "rejects synchronous %s reentry before either owner is published",
    async (stage) => {
      const directory = await tempRoot(`fs-safe-sync-admission-${stage}-`);
      const target = path.join(directory, "state.json");
      const outerLockPath = path.join(directory, "outer.lock");
      const nestedLockPath = path.join(directory, "nested.lock");
      const nestedPayload = vi.fn(() => ({ owner: "nested" }));
      const open = vi.spyOn(fsSync, "openSync");
      let nestedError: unknown;
      const reenter = () => {
        try {
          acquireFileLockSync(path.join(directory, ".", "state.json"), {
            ...syncOptions(nestedPayload),
            lockPath: nestedLockPath,
            reentrantOwner: "owner",
          });
        } catch (error) {
          nestedError = error;
        }
      };
      const payload = stage === "payload"
        ? () => {
            reenter();
            return { owner: "outer" };
          }
        : () => ({
            owner: "outer",
            toJSON() {
              reenter();
              return { owner: "outer" };
            },
          });

      const outer = acquireFileLockSync(target, {
        ...syncOptions(payload),
        lockPath: outerLockPath,
        reentrantOwner: "owner",
      });
      try {
        expect(nestedError).toMatchObject({
          code: "file_lock_timeout",
          lockPath: nestedLockPath,
          normalizedTargetPath: outer.normalizedTargetPath,
        });
        expect(nestedPayload).not.toHaveBeenCalled();
        expect(open.mock.calls.some(([candidate]) => String(candidate) === nestedLockPath)).toBe(false);
        expect(syncAdmissions().size).toBe(0);
      } finally {
        outer.release();
      }
      expect(fsSync.existsSync(outerLockPath)).toBe(false);
      expect(fsSync.existsSync(nestedLockPath)).toBe(false);
    },
  );

  it.each(["parsePayload", "shouldReclaim", "shouldRemoveStaleLock"] as const)(
    "keeps synchronous %s reentry outside the admission transaction",
    async (stage) => {
      const directory = await tempRoot(`fs-safe-sync-admission-${stage}-`);
      const target = path.join(directory, "state.json");
      const outerLockPath = path.join(directory, "stale.lock");
      const nestedLockPath = path.join(directory, "nested.lock");
      fsSync.writeFileSync(outerLockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));
      const nestedPayload = vi.fn(() => ({ owner: "nested" }));
      const open = vi.spyOn(fsSync, "openSync");
      let nestedError: unknown;
      const reenter = () => {
        try {
          acquireFileLockSync(target, {
            ...syncOptions(nestedPayload),
            lockPath: nestedLockPath,
          });
        } catch (error) {
          nestedError = error;
        }
      };

      const acquire = () => acquireFileLockSync(target, {
        ...syncOptions(() => ({ owner: "outer" })),
        lockPath: outerLockPath,
        staleMs: 1,
        staleRecovery: "remove-if-unchanged",
        parsePayload: (raw) => {
          if (stage === "parsePayload") reenter();
          return JSON.parse(raw) as unknown;
        },
        shouldReclaim: () => {
          if (stage === "shouldReclaim") reenter();
          return stage === "shouldRemoveStaleLock";
        },
        shouldRemoveStaleLock: () => {
          if (stage === "shouldRemoveStaleLock") reenter();
          return false;
        },
      });
      expect(acquire).toThrow(expect.objectContaining({
        code: stage === "shouldRemoveStaleLock" ? "file_lock_stale" : "file_lock_timeout",
      }));
      expect(nestedError).toMatchObject({
        code: "file_lock_timeout",
        lockPath: nestedLockPath,
        normalizedTargetPath: path.resolve(target),
      });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(open.mock.calls.some(([candidate]) => String(candidate) === nestedLockPath)).toBe(false);
      expect(syncAdmissions().size).toBe(0);
      expect(fsSync.existsSync(nestedLockPath)).toBe(false);
    },
  );

  it("reuses only a completed matching synchronous owner and contends before sidecar I/O", async () => {
    const directory = await tempRoot("fs-safe-sync-admission-owner-");
    const target = path.join(directory, "state.json");
    const firstPath = path.join(directory, "first.lock");
    const alternatePath = path.join(directory, "alternate.lock");
    const first = acquireFileLockSync(target, {
      ...syncOptions(() => ({ owner: "first" })),
      lockPath: firstPath,
      reentrantOwner: "owner-a",
    });
    const open = vi.spyOn(fsSync, "openSync");
    const sameOwner = acquireFileLockSync(path.join(directory, ".", "state.json"), {
      ...syncOptions(() => ({ owner: "same" })),
      lockPath: alternatePath,
      reentrantOwner: "owner-a",
    });
    const foreignPayload = vi.fn(() => ({ owner: "foreign" }));
    try {
      expect(sameOwner.lockPath).toBe(firstPath);
      expect(() => acquireFileLockSync(target, {
        ...syncOptions(foreignPayload),
        lockPath: alternatePath,
        reentrantOwner: "owner-b",
      })).toThrow(expect.objectContaining({
        code: "file_lock_timeout",
        lockPath: alternatePath,
        normalizedTargetPath: first.normalizedTargetPath,
      }));
      expect(foreignPayload).toHaveBeenCalledOnce();
      expect(open.mock.calls.some(([candidate]) => String(candidate) === alternatePath)).toBe(false);
    } finally {
      sameOwner.release();
      first.release();
    }
  });

  it.each([false, true])(
    "rolls back first-time synchronous cleanup registration when process.on throws afterAdd=%s",
    async (afterAdd) => {
      resetSyncCleanupRegistration();
      const directory = await tempRoot("fs-safe-sync-admission-register-throw-");
      const target = path.join(directory, "state.json");
      const lockPath = `${target}.lock`;
      const failure = new Error("exit listener rejected");
      const realOn = process.on;
      const on = vi.spyOn(process, "on");
      on.mockImplementation((function (this: NodeJS.Process, eventName, listener) {
        if (eventName === "exit") {
          if (afterAdd) Reflect.apply(realOn, this, [eventName, listener]);
          throw failure;
        }
        return Reflect.apply(realOn, this, [eventName, listener]);
      }) as typeof process.on);

      expect(() => acquireFileLockSync(target, syncOptions(() => ({})))).toThrow(failure);
      expect(fsSync.existsSync(lockPath)).toBe(false);
      expect(Reflect.get(globalThis, syncCleanupKey)).toBeUndefined();
      expect(Reflect.get(globalThis, syncCleanupHandlerKey)).toBeUndefined();
      expect(Reflect.get(globalThis, syncCleanupRegistrationKey)).toBeUndefined();
      expect(syncAdmissions().size).toBe(0);
      on.mockRestore();

      const retry = acquireFileLockSync(target, syncOptions(() => ({ owner: "retry" })));
      retry.release();
    },
  );

  it("fails closed on different-target newListener reentry and completes registration", async () => {
    resetSyncCleanupRegistration();
    const directory = await tempRoot("fs-safe-sync-admission-new-listener-");
    const target = path.join(directory, "state.json");
    const nestedTarget = path.join(directory, "nested-state.json");
    const nestedLockPath = path.join(directory, "nested.lock");
    let nestedError: unknown;
    let fired = false;
    const onNewListener = (eventName: string | symbol) => {
      if (eventName !== "exit" || fired) return;
      fired = true;
      try {
        acquireFileLockSync(nestedTarget, {
          ...syncOptions(() => ({ owner: "nested" })),
          lockPath: nestedLockPath,
        });
      } catch (error) {
        nestedError = error;
      }
    };
    process.on("newListener", onNewListener);
    try {
      const outer = acquireFileLockSync(target, syncOptions(() => ({ owner: "outer" })));
      expect(nestedError).toMatchObject({
        code: "file_lock_timeout",
        lockPath: nestedLockPath,
        normalizedTargetPath: path.resolve(nestedTarget),
      });
      expect(Reflect.get(globalThis, syncCleanupKey)).toBe(true);
      expect(Reflect.get(globalThis, syncCleanupRegistrationKey)).toBeUndefined();
      expect(syncAdmissions().size).toBe(0);
      expect(fsSync.existsSync(nestedLockPath)).toBe(false);
      outer.release();
    } finally {
      process.off("newListener", onNewListener);
    }
  });

  it("rolls back synchronous publication when compromise-timer setup throws", async () => {
    resetSyncCleanupRegistration();
    const directory = await tempRoot("fs-safe-sync-admission-timer-");
    const target = path.join(directory, "state.json");
    const failure = new Error("timer setup failed");
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce((() => {
      throw failure;
    }) as typeof setInterval);

    expect(() => acquireFileLockSync(target, {
      ...syncOptions(() => ({ owner: "timer" })),
      compromiseCheckIntervalMs: 1,
      onCompromised: () => undefined,
    })).toThrow(failure);
    expect(fsSync.existsSync(`${target}.lock`)).toBe(false);
    expect((Reflect.get(globalThis, syncHeldKey) as Map<string, unknown>).size).toBe(0);
    expect(syncAdmissions().size).toBe(0);
  });

  it("serializes concurrent async aliases even when their explicit sidecars differ", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-admission-pending-");
    const target = path.join(directory, "state.json");
    const firstPath = path.join(directory, "first.lock");
    const secondPath = path.join(directory, "second.lock");
    const key = `admission-pending:${directory}`;
    const manager = createSidecarLockManager(key);
    const entered = deferred();
    const resume = deferred();
    const firstPromise = manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: firstPath,
      reentrantOwner: "owner",
      payload: async () => {
        entered.resolve();
        await resume.promise;
        return { owner: "first" };
      },
    });
    await entered.promise;
    const open = vi.spyOn(fs, "open");
    const secondPayload = vi.fn(async () => ({ owner: "second" }));
    try {
      await expect(manager.acquire({
        targetPath: path.join(directory, ".", "state.json"),
        staleMs: 30_000,
        lockPath: secondPath,
        reentrantOwner: "owner",
        payload: secondPayload,
        timeoutMs: 0,
        retry: { retries: 0 },
      })).rejects.toMatchObject({
        code: "file_lock_timeout",
        lockPath: secondPath,
        normalizedTargetPath: path.resolve(target),
      });
      expect(secondPayload).not.toHaveBeenCalled();
      expect(open.mock.calls.some(([candidate]) => String(candidate) === secondPath)).toBe(false);
      expect(managerState(key).held.size).toBe(0);
      expect(managerState(key).admissions.size).toBe(1);
    } finally {
      resume.resolve();
      const first = await firstPromise;
      await first.release();
    }
    expect(managerState(key).held.size).toBe(0);
    expect(managerState(key).admissions.size).toBe(0);
  });

  it("releases async admission during backoff so another explicit sidecar can win", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-admission-backoff-");
    const target = path.join(directory, "state.json");
    const waitingPath = path.join(directory, "waiting.lock");
    const winnerPath = path.join(directory, "winner.lock");
    await fs.writeFile(waitingPath, JSON.stringify({ createdAt: new Date().toISOString() }));
    const key = `admission-backoff:${directory}`;
    const manager = createSidecarLockManager(key);
    const sleeping = deferred();
    let resumeSleep: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    const placeholder = realSetTimeout(() => undefined, 10_000);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (delay === 123) {
        resumeSleep = () => Reflect.apply(callback, undefined, args);
        sleeping.resolve();
        return placeholder;
      }
      return Reflect.apply(realSetTimeout, globalThis, [callback, delay, ...args]);
    }) as typeof setTimeout);

    const waiting = manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: waitingPath,
      payload: async () => ({ owner: "waiting" }),
      shouldReclaim: () => false,
      retry: { retries: 1, minTimeout: 123, maxTimeout: 123 },
    });
    let winner: { release(): Promise<void> } | undefined;
    try {
      await sleeping.promise;
      expect(managerState(key).admissions.size).toBe(0);
      winner = await manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        lockPath: winnerPath,
        payload: async () => ({ owner: "winner" }),
        retry: { retries: 0 },
      });
      resumeSleep?.();
      await expect(waiting).rejects.toMatchObject({ code: "file_lock_timeout" });
    } finally {
      resumeSleep?.();
      clearTimeout(placeholder);
      await winner?.release();
      await waiting.catch(() => undefined);
    }
    expect(managerState(key).admissions.size).toBe(0);
    expect(managerState(key).held.size).toBe(0);
  });

  it("reuses a completed async owner but blocks a foreign owner before sidecar I/O", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-admission-owner-");
    const target = path.join(directory, "state.json");
    const firstPath = path.join(directory, "first.lock");
    const alternatePath = path.join(directory, "alternate.lock");
    const key = `admission-owner:${directory}`;
    const manager = createSidecarLockManager(key);
    const first = await manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: firstPath,
      reentrantOwner: "owner-a",
      payload: async () => ({ owner: "first" }),
    });
    const open = vi.spyOn(fs, "open");
    const same = await manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: alternatePath,
      reentrantOwner: "owner-a",
      payload: async () => ({ owner: "same" }),
    });
    const foreignPayload = vi.fn(async () => ({ owner: "foreign" }));
    try {
      expect(same.lockPath).toBe(firstPath);
      await expect(manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        lockPath: alternatePath,
        reentrantOwner: "owner-b",
        payload: foreignPayload,
        timeoutMs: 0,
        retry: { retries: 0 },
      })).rejects.toMatchObject({ code: "file_lock_timeout", lockPath: alternatePath });
      expect(foreignPayload).toHaveBeenCalledOnce();
      expect(open.mock.calls.some(([candidate]) => String(candidate) === alternatePath)).toBe(false);
    } finally {
      await same.release();
      await first.release();
    }
  });

  it("rolls back async publication and its token when compromise-timer setup throws", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-admission-timer-");
    const target = path.join(directory, "state.json");
    const key = `admission-timer:${directory}`;
    const manager = createSidecarLockManager(key);
    const failure = new Error("timer setup failed");
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce((() => {
      throw failure;
    }) as typeof setInterval);

    await expect(manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      payload: async () => ({ owner: "timer" }),
      compromiseCheckIntervalMs: 1,
      onCompromised: () => undefined,
    })).rejects.toBe(failure);
    await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(managerState(key).held.size).toBe(0);
    expect(managerState(key).admissions.size).toBe(0);
  });
});
