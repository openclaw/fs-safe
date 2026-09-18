import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLockSync,
  type FileLockSyncAcquireOptions,
} from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  createSidecarLockManager,
  type SidecarLockAcquireOptions,
} from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const syncHeldKey = Symbol.for("fsSafe.syncSidecarLocks");
const syncAdmissionsKey = Symbol.for("fsSafe.syncSidecarLockAdmissions");
const syncCleanupHandlerKey = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");

type ManagerState = {
  held: Map<string, unknown>;
  admissions: Map<string, object>;
};

function managerState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
    string,
    ManagerState
  >;
  return managers.get(key)!;
}

function shadowCall<T extends object>(callback: T): T {
  return new Proxy(callback, {
    get(target, property, receiver) {
      if (property === "call") throw new Error("callback.call was observed");
      return Reflect.get(target, property, receiver);
    },
  });
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
  (Reflect.get(globalThis, syncCleanupHandlerKey) as (() => void) | undefined)?.();
  (Reflect.get(globalThis, syncHeldKey) as Map<string, unknown> | undefined)?.clear();
  (Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object> | undefined)?.clear();
});

describe("sidecar-lock admission option snapshots", () => {
  it("never turns an anonymous synchronous holder reentrant through a stateful accessor", async () => {
    const directory = await tempRoot("fs-safe-sync-owner-accessor-");
    const target = path.join(directory, "state.json");
    const held = acquireFileLockSync(target, { payload: () => ({ owner: "held" }) });
    const payload = vi.fn(() => ({ owner: "candidate" }));
    let ownerReads = 0;
    const options = {
      lockPath: path.join(directory, "alternate.lock"),
      payload,
      retry: { retries: 0 },
      timeoutMs: 0,
      get reentrantOwner() {
        ownerReads += 1;
        return ownerReads === 1 ? "candidate" : undefined;
      },
    };
    try {
      expect(() => acquireFileLockSync(target, options)).toThrow(expect.objectContaining({
        code: "file_lock_timeout",
        lockPath: options.lockPath,
      }));
      expect(ownerReads).toBe(1);
      expect(payload).toHaveBeenCalledOnce();
      expect(held.verifyStillHeld()).toBe(true);
    } finally {
      held.release();
    }
  });

  it("uses one async owner snapshot for completed reentrancy", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-owner-accessor-");
    const target = path.join(directory, "state.json");
    const firstPath = path.join(directory, "first.lock");
    const alternatePath = path.join(directory, "alternate.lock");
    const key = `owner-accessor:${directory}`;
    const manager = createSidecarLockManager(key);
    const first = await manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: firstPath,
      reentrantOwner: "owner",
      payload: async () => ({ owner: "first" }),
    });
    const payload = vi.fn(async () => ({ owner: "candidate" }));
    let ownerReads = 0;
    let retainReads = 0;
    const options = {
      targetPath: target,
      staleMs: 30_000,
      lockPath: alternatePath,
      payload,
      get reentrantOwner() {
        ownerReads += 1;
        return ownerReads === 1 ? "owner" : "changed";
      },
      get retainOnExit() {
        retainReads += 1;
        return retainReads === 1;
      },
    };
    const nested = await manager.acquire(options);
    try {
      expect(nested.lockPath).toBe(firstPath);
      expect(ownerReads).toBe(1);
      expect(retainReads).toBe(1);
      expect([...managerState(key).held.values()][0]).toMatchObject({ retainOnExit: true });
      expect(payload).not.toHaveBeenCalled();
    } finally {
      await nested.release();
      await first.release();
    }
  });

  it("captures synchronous callback policies once across retries and preserves receivers", async () => {
    const directory = await tempRoot("fs-safe-sync-policy-accessor-");
    const target = path.join(directory, "state.json");
    const lockPath = `${target}.lock`;
    fsSync.writeFileSync(lockPath, JSON.stringify({ createdAt: new Date().toISOString() }));
    const reads = new Map<string, number>();
    const calls = new Map<string, number>();
    const read = (name: string) => reads.set(name, (reads.get(name) ?? 0) + 1);
    const call = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
    let options!: FileLockSyncAcquireOptions<Record<string, unknown>>;
    options = {
      lockPath,
      retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
      timeoutMs: Number.POSITIVE_INFINITY,
      get payload() {
        read("payload");
        return function (this: unknown) {
          expect(this).toBe(options);
          call("payload");
          return { owner: "candidate" };
        };
      },
      get parsePayload() {
        read("parsePayload");
        return (raw: string) => JSON.parse(raw) as unknown;
      },
      get shouldReclaim() {
        read("shouldReclaim");
        return function (this: unknown) {
          expect(this).toBe(options);
          call("shouldReclaim");
          return false;
        };
      },
      get shouldRemoveStaleLock() {
        read("shouldRemoveStaleLock");
        return () => false;
      },
      get staleRecovery() {
        read("staleRecovery");
        return "fail-closed" as const;
      },
      get onCompromised() {
        read("onCompromised");
        return undefined;
      },
    };

    expect(() => acquireFileLockSync(target, options)).toThrow(expect.objectContaining({
      code: "file_lock_timeout",
    }));
    expect(Object.fromEntries(reads)).toEqual({
      staleRecovery: 1,
      payload: 1,
      onCompromised: 1,
      parsePayload: 1,
      shouldReclaim: 1,
      shouldRemoveStaleLock: 1,
    });
    expect(Object.fromEntries(calls)).toEqual({ payload: 2, shouldReclaim: 2 });
    expect((Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>).size).toBe(0);
  });

  it("captures async policies once except for byte-first per-attempt parsers", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-policy-accessor-");
    const target = path.join(directory, "state.json");
    const lockPath = `${target}.lock`;
    const key = `policy-accessor:${directory}`;
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: new Date().toISOString() }));
    const manager = createSidecarLockManager(key);
    const reads = new Map<string, number>();
    const calls = new Map<string, number>();
    const read = (name: string) => reads.set(name, (reads.get(name) ?? 0) + 1);
    const call = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
    let options!: SidecarLockAcquireOptions<Record<string, unknown>>;
    options = {
      targetPath: target,
      lockPath,
      staleMs: 30_000,
      retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
      get payload() {
        read("payload");
        return async function (this: unknown) {
          expect(this).toBe(options);
          call("payload");
          return { owner: "candidate" };
        };
      },
      get metadata() {
        read("metadata");
        return {};
      },
      get parsePayload() {
        read("parsePayload");
        return (raw: string) => JSON.parse(raw) as unknown;
      },
      get shouldReclaim() {
        read("shouldReclaim");
        return async function (this: unknown) {
          expect(this).toBeUndefined();
          call("shouldReclaim");
          return false;
        };
      },
      get shouldRemoveStaleLock() {
        read("shouldRemoveStaleLock");
        return async () => false;
      },
      get staleRecovery() {
        read("staleRecovery");
        return "fail-closed" as const;
      },
      get onCompromised() {
        read("onCompromised");
        return undefined;
      },
    };

    await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(Object.fromEntries(reads)).toEqual({
      payload: 1,
      metadata: 1,
      onCompromised: 1,
      parsePayload: 2,
      shouldReclaim: 1,
      shouldRemoveStaleLock: 1,
      staleRecovery: 1,
    });
    expect(Object.fromEntries(calls)).toEqual({ payload: 2, shouldReclaim: 2 });
    expect(managerState(key).admissions.size).toBe(0);
    expect(managerState(key).held.size).toBe(0);
  });

  it.each(["payload", "toJSON"] as const)(
    "cleans sync and async admission tokens when %s fails",
    async (stage) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-admission-callback-${stage}-`);
      const failure = new Error(`${stage} failed`);
      const makePayload = () => {
        if (stage === "payload") throw failure;
        return { toJSON: () => { throw failure; } };
      };
      const syncTarget = path.join(directory, "sync.json");
      expect(() => acquireFileLockSync(syncTarget, { payload: makePayload })).toThrow(failure);
      expect((Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>).size).toBe(0);
      expect(fsSync.existsSync(`${syncTarget}.lock`)).toBe(false);

      const asyncTarget = path.join(directory, "async.json");
      const key = `callback-failure:${stage}:${directory}`;
      const manager = createSidecarLockManager(key);
      await expect(manager.acquire({
        targetPath: asyncTarget,
        staleMs: 30_000,
        payload: async () => makePayload(),
      })).rejects.toBe(failure);
      expect(managerState(key).admissions.size).toBe(0);
      expect(managerState(key).held.size).toBe(0);
      await expect(fs.access(`${asyncTarget}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["sync", "async"] as const)(
    "cleans %s admission when a captured payload accessor throws",
    async (mode) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-${mode}-payload-accessor-failure-`);
      const target = path.join(directory, "state.json");
      const failure = new Error("payload accessor failed");
      let reads = 0;
      const payloadAccessor = {
        get payload(): () => Record<string, unknown> {
          reads += 1;
          throw failure;
        },
      };
      if (mode === "sync") {
        expect(() => acquireFileLockSync(target, payloadAccessor)).toThrow(failure);
        expect((Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>).size).toBe(0);
      } else {
        const key = `payload-accessor-failure:${directory}`;
        const manager = createSidecarLockManager(key);
        const asyncOptions = {
          targetPath: target,
          staleMs: 30_000,
        } as SidecarLockAcquireOptions<Record<string, unknown>>;
        Object.defineProperty(
          asyncOptions,
          "payload",
          Object.getOwnPropertyDescriptor(payloadAccessor, "payload")!,
        );
        await expect(manager.acquire(asyncOptions)).rejects.toBe(failure);
        expect(managerState(key).admissions.size).toBe(0);
        expect(managerState(key).held.size).toBe(0);
      }
      expect(reads).toBe(1);
      await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("invokes all synchronous callbacks without observing a shadowed call property", async () => {
    const directory = await tempRoot("fs-safe-sync-shadowed-call-");
    const target = path.join(directory, "state.json");
    const lockPath = `${target}.lock`;
    fsSync.writeFileSync(lockPath, JSON.stringify({ createdAt: "1970-01-01T00:00:00.000Z" }));
    let tick = (): void => undefined;
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce(((callback: () => void) => {
      tick = callback;
      return timer;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    let options!: FileLockSyncAcquireOptions<Record<string, unknown>>;
    const payload = shadowCall(vi.fn(function (this: unknown) {
      expect(this).toBe(options);
      return { owner: "candidate" };
    }));
    const shouldReclaim = shadowCall(vi.fn(function (this: unknown) {
      expect(this).toBe(options);
      return true;
    }));
    const shouldRemoveStaleLock = shadowCall(vi.fn(function (this: unknown) {
      expect(this).toBe(options);
      return true;
    }));
    const onCompromised = shadowCall(vi.fn(function (this: unknown) {
      expect(this).toBe(options);
    }));
    let compromisedReads = 0;
    options = {
      lockPath,
      payload,
      staleMs: 1,
      staleRecovery: "remove-if-unchanged",
      shouldReclaim,
      shouldRemoveStaleLock,
      compromiseCheckIntervalMs: 1,
    };
    Object.defineProperty(options, "onCompromised", {
      configurable: true,
      get() {
        compromisedReads += 1;
        return onCompromised;
      },
    });

    const lock = acquireFileLockSync(target, options);
    try {
      expect(compromisedReads).toBe(1);
      Object.defineProperty(options, "onCompromised", {
        configurable: true,
        get() { throw new Error("onCompromised was observed after admission"); },
      });
      expect(payload).toHaveBeenCalledTimes(2);
      expect(shouldReclaim).toHaveBeenCalledOnce();
      expect(shouldRemoveStaleLock).toHaveBeenCalledOnce();
      fsSync.unlinkSync(lock.lockPath);
      tick();
      expect(onCompromised).toHaveBeenCalledOnce();
    } finally {
      lock.release();
    }
  });

  it("invokes all asynchronous callbacks without observing a shadowed call property", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-shadowed-call-");
    const target = path.join(directory, "state.json");
    const lockPath = `${target}.lock`;
    const key = `shadowed-call:${directory}`;
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: "1970-01-01T00:00:00.000Z" }));
    let tick = (): void => undefined;
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce(((callback: () => void) => {
      tick = callback;
      return timer;
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    let options!: SidecarLockAcquireOptions<Record<string, unknown>>;
    let removeReceiver: unknown;
    const payload = shadowCall(vi.fn(async function (this: unknown) {
      expect(this).toBe(options);
      return { owner: "candidate" };
    }));
    const shouldReclaim = shadowCall(vi.fn(async function (this: unknown) {
      expect(this).toBeUndefined();
      return true;
    }));
    const shouldRemoveStaleLock = shadowCall(vi.fn(async function (this: unknown) {
      removeReceiver = this;
      return true;
    }));
    const onCompromised = shadowCall(vi.fn(function (this: unknown) {
      expect(this).toBe(options);
    }));
    let compromisedReads = 0;
    options = {
      targetPath: target,
      lockPath,
      staleMs: 1,
      payload,
      staleRecovery: "remove-if-unchanged",
      shouldReclaim,
      shouldRemoveStaleLock,
      compromiseCheckIntervalMs: 1,
    };
    Object.defineProperty(options, "onCompromised", {
      configurable: true,
      get() {
        compromisedReads += 1;
        return onCompromised;
      },
    });

    const lock = await createSidecarLockManager(key).acquire(options);
    try {
      expect(compromisedReads).toBe(1);
      Object.defineProperty(options, "onCompromised", {
        configurable: true,
        get() { throw new Error("onCompromised was observed after admission"); },
      });
      expect(payload).toHaveBeenCalledTimes(2);
      expect(shouldReclaim).toHaveBeenCalledOnce();
      expect(shouldRemoveStaleLock).toHaveBeenCalledOnce();
      expect(removeReceiver).not.toBe(options);
      expect(removeReceiver).toMatchObject({ lockPath, normalizedTargetPath: target });
      await fs.unlink(lock.lockPath);
      tick();
      await vi.waitFor(() => expect(onCompromised).toHaveBeenCalledOnce());
    } finally {
      await lock.release();
    }
  });
});
