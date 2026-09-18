import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  createSidecarLockManager,
  type SidecarLockHandle,
} from "../src/sidecar-lock.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");

type ManagerState = {
  held: Map<string, unknown>;
  admissions: Map<string, object>;
};

function managerState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, managersKey) as Map<string, ManagerState>;
  return managers.get(key)!;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

describe("asynchronous same-manager sidecar retry compatibility", () => {
  it.each([
    { retries: 0, releaseAfter: undefined, calls: 1, waits: 0, succeeds: false },
    { retries: 2, releaseAfter: 2, calls: 3, waits: 2, succeeds: true },
  ] as const)(
    "preserves $retries-retry payload accounting for a completed foreign holder",
    async ({ retries, releaseAfter, calls, waits: expectedWaits, succeeds }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-manager-budget-${retries}-`);
      const target = path.join(directory, "state.json");
      const holderPath = path.join(directory, "holder.lock");
      const candidatePath = path.join(directory, "candidate.lock");
      const key = `same-manager-budget:${retries}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        lockPath: holderPath,
        reentrantOwner: "holder",
        payload: async () => ({ owner: "holder" }),
      });
      const original = await fs.readFile(holderPath, "utf8");
      const open = vi.spyOn(fs, "open");
      const payload = vi.fn(async () => ({ owner: "candidate" }));
      const waitDelays: number[] = [];
      let holderRelease: Promise<void> | undefined;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay = 0, ...args) => {
        waitDelays.push(delay);
        if (releaseAfter !== undefined && waitDelays.length === releaseAfter) {
          holderRelease = holder.release();
        }
        queueMicrotask(() => Reflect.apply(callback, undefined, args));
        return {} as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      let candidate: SidecarLockHandle | undefined;
      try {
        const acquiring = manager.acquire({
          targetPath: target,
          staleMs: 30_000,
          lockPath: candidatePath,
          reentrantOwner: "candidate",
          payload,
          timeoutMs: Number.POSITIVE_INFINITY,
          retry: { retries, minTimeout: 0, maxTimeout: 0 },
        });
        if (succeeds) candidate = await acquiring;
        else await expect(acquiring).rejects.toMatchObject({ code: "file_lock_timeout" });
        await holderRelease;
        expect(payload).toHaveBeenCalledTimes(calls);
        expect(waitDelays).toEqual(Array(expectedWaits).fill(0));
        const candidateOpens = open.mock.calls.filter(([candidateFile]) =>
          String(candidateFile) === candidatePath);
        expect(candidateOpens).toHaveLength(succeeds ? 1 : 0);
        if (candidate) expect(await candidate.verifyStillHeld()).toBe(true);
        else {
          expect(await holder.verifyStillHeld()).toBe(true);
          expect(await fs.readFile(holderPath, "utf8")).toBe(original);
          await expect(fs.access(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(managerState(key).admissions.size).toBe(0);
      } finally {
        await holderRelease?.catch(() => undefined);
        await candidate?.release().catch(() => undefined);
        await holder.release().catch(() => undefined);
        await manager.drain();
      }
    },
  );

  it.each([
    { retries: 0, explicitSame: false },
    { retries: 3, explicitSame: false },
    { retries: 0, explicitSame: true },
    { retries: 3, explicitSame: true },
  ] as const)(
    "preserves default-sidecar parser observations across $retries retries (explicit same: $explicitSame)",
    async ({ retries, explicitSame }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-parser-budget-${retries}-`);
      const target = path.join(directory, "state.json");
      const key = `parser-budget:${retries}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath: target, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      const holderRaw = await fs.readFile(holder.lockPath, "utf8");
      const order: string[] = [];
      __setFsSafeTestHooksForTest({
        beforeSidecarLockSnapshotOpen(inspectedPath) {
          if (inspectedPath === holder.lockPath) order.push("observe");
        },
      });
      const parsePayload = vi.fn((raw: string) => {
        order.push("parse");
        expect(raw).toBe(holderRaw);
        return { owner: "holder" };
      });
      const options = {
        targetPath: target, staleMs: 30_000, timeoutMs: Number.POSITIVE_INFINITY,
        retry: { retries, minTimeout: 0, maxTimeout: 0 },
        payload: async () => ({
          toJSON() { order.push("serialize"); return { owner: "candidate" }; },
        }),
      };
      Object.defineProperty(options, "payload", {
        value: vi.fn(async () => {
          order.push("payload");
          return { toJSON() { order.push("serialize"); return { owner: "candidate" }; } };
        }),
      });
      Object.defineProperty(options, "parsePayload", {
        get() { order.push("accessor"); return parsePayload; },
      });
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, _delay, ...args) => {
        queueMicrotask(() => Reflect.apply(callback, undefined, args));
        return {} as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      if (explicitSame) Reflect.set(options, "lockPath", holder.lockPath);
      try {
        await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
        const attempts = retries + 1;
        expect(order).toEqual(Array.from(
          { length: attempts }, () => ["payload", "serialize", "observe", "accessor", "parse"],
        ).flat());
        expect(parsePayload).toHaveBeenCalledTimes(attempts);
        expect(await holder.verifyStillHeld()).toBe(true);
        expect(managerState(key).admissions.size).toBe(0);
      } finally {
        await holder.release().catch(() => undefined);
        await manager.drain();
      }
    },
  );

  it.each(["accessor", "callback"] as const)(
    "preserves exact default-sidecar parser %s failure ordering",
    async (stage) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-parser-${stage}-`);
      const target = path.join(directory, "state.json");
      const key = `parser-${stage}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath: target, staleMs: 30_000, payload: async () => ({ owner: "holder" }),
      });
      const failure = new Error(`parser ${stage} failed`);
      const order: string[] = [];
      const options = {
        targetPath: target, staleMs: 30_000,
        payload: async () => ({
          toJSON() { order.push("serialize"); return { owner: "candidate" }; },
        }),
      };
      Object.defineProperty(options, "payload", {
        value: async () => {
          order.push("payload");
          return { toJSON() { order.push("serialize"); return { owner: "candidate" }; } };
        },
      });
      Object.defineProperty(options, "parsePayload", {
        get() {
          order.push("accessor");
          if (stage === "accessor") throw failure;
          return () => { order.push("parse"); throw failure; };
        },
      });
      try {
        expect(await manager.acquire(options).then(() => undefined, (error) => error)).toBe(failure);
        expect(order).toEqual(stage === "accessor"
          ? ["payload", "serialize", "accessor"]
          : ["payload", "serialize", "accessor", "parse"]);
        expect(await holder.verifyStillHeld()).toBe(true);
        expect(managerState(key).admissions.size).toBe(0);
      } finally {
        await holder.release().catch(() => undefined);
        await manager.drain();
      }
    },
  );

  it("preserves raw-observation failure precedence over parser access", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-parser-observation-failure-");
    const target = path.join(directory, "state.json");
    const key = `parser-observation-failure:${directory}`;
    const manager = createSidecarLockManager(key);
    const holder = await manager.acquire({
      targetPath: target, staleMs: 30_000, payload: async () => ({ owner: "holder" }),
    });
    const observationFailure = new Error("observation failed");
    const accessorFailure = new Error("parser accessor failed");
    let accessorCalls = 0;
    __setFsSafeTestHooksForTest({
      beforeSidecarLockSnapshotOpen(inspectedPath) {
        if (inspectedPath === holder.lockPath) throw observationFailure;
      },
    });
    const options = {
      targetPath: target, staleMs: 30_000,
      payload: async () => ({ owner: "candidate" }),
    };
    Object.defineProperty(options, "parsePayload", {
      get() { accessorCalls += 1; throw accessorFailure; },
    });
    try {
      expect(await manager.acquire(options).then(
        () => undefined,
        (error: unknown) => error,
      )).toBe(observationFailure);
      expect(accessorCalls).toBe(0);
      expect(managerState(key).admissions.size).toBe(0);
    } finally {
      __setFsSafeTestHooksForTest();
      await holder.release().catch(() => undefined);
      await manager.drain();
    }
  });

  it("does not observe a parser or open a distinct explicit sidecar for a foreign holder", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-parser-alternate-");
    const target = path.join(directory, "state.json");
    const alternate = path.join(directory, "alternate.lock");
    const key = `parser-alternate:${directory}`;
    const manager = createSidecarLockManager(key);
    const holder = await manager.acquire({
      targetPath: target, staleMs: 30_000, payload: async () => ({ owner: "holder" }),
    });
    const parser = vi.fn((raw: string) => raw);
    let accessorCalls = 0;
    const payload = vi.fn(async () => ({ owner: "candidate" }));
    const options = {
      targetPath: target, lockPath: alternate, staleMs: 30_000,
      timeoutMs: 0, retry: { retries: 0 }, payload,
    };
    Object.defineProperty(options, "parsePayload", {
      get() { accessorCalls += 1; return parser; },
    });
    const open = vi.spyOn(fs, "open");
    try {
      await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(payload).toHaveBeenCalledOnce();
      expect(accessorCalls).toBe(0);
      expect(parser).not.toHaveBeenCalled();
      expect(open.mock.calls.some(([candidate]) => String(candidate) === alternate)).toBe(false);
      expect(await holder.verifyStillHeld()).toBe(true);
    } finally {
      await holder.release().catch(() => undefined);
      await manager.drain();
    }
  });

  it.each(["awaited-payload", "serialization"] as const)(
    "reuses one serialized attempt when the holder releases during %s",
    async (stage) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-release-${stage}-`);
      const target = path.join(directory, "state.json");
      const holderPath = path.join(directory, "holder.lock");
      const candidatePath = path.join(directory, "candidate.lock");
      const key = `release-during:${stage}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        lockPath: holderPath,
        payload: async () => ({ owner: "holder" }),
      });
      const sleep = vi.spyOn(globalThis, "setTimeout");
      let holderRelease: Promise<void> | undefined;
      const toJSON = vi.fn(() => {
        if (stage === "serialization") holderRelease = holder.release();
        return { owner: "candidate" };
      });
      const payload = vi.fn(async () => {
        if (stage === "awaited-payload") await holder.release();
        return { toJSON };
      });
      let candidate: SidecarLockHandle | undefined;
      try {
        candidate = await manager.acquire({
          targetPath: target,
          staleMs: 30_000,
          lockPath: candidatePath,
          payload,
          timeoutMs: 0,
          retry: { retries: 0 },
        });
        await holderRelease;
        expect(payload).toHaveBeenCalledOnce();
        expect(toJSON).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
        expect(await candidate.verifyStillHeld()).toBe(true);
        expect(JSON.parse(await fs.readFile(candidatePath, "utf8"))).toEqual({
          owner: "candidate",
        });
      } finally {
        await holderRelease?.catch(() => undefined);
        await candidate?.release().catch(() => undefined);
        await holder.release().catch(() => undefined);
        await manager.drain();
      }
    },
  );

  it("joins a release interleaved with an awaited payload without spending a retry", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-release-interleaved-");
    const target = path.join(directory, "state.json");
    const candidatePath = path.join(directory, "candidate.lock");
    const key = `release-interleaved:${directory}`;
    const manager = createSidecarLockManager(key);
    const holder = await manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      payload: async () => ({ owner: "holder" }),
    });
    const entered = deferred();
    const resume = deferred();
    const payload = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
      return { owner: "candidate" };
    });
    const sleep = vi.spyOn(globalThis, "setTimeout");
    const acquiring = manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: candidatePath,
      payload,
      timeoutMs: 0,
      retry: { retries: 0 },
    });
    await entered.promise;
    expect(managerState(key).admissions.size).toBe(1);
    const holderRelease = holder.release();
    resume.resolve();
    let candidate: SidecarLockHandle | undefined;
    try {
      candidate = await acquiring;
      await holderRelease;
      expect(payload).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
      expect(await candidate.verifyStillHeld()).toBe(true);
      expect(managerState(key).admissions.size).toBe(0);
    } finally {
      resume.resolve();
      await holderRelease.catch(() => undefined);
      await candidate?.release().catch(() => undefined);
      await acquiring.catch(() => undefined);
      await manager.drain();
    }
  });

  it("fails closed when awaited payload loses its admission token", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-token-loss-");
    const target = path.join(directory, "state.json");
    const key = `token-loss:${directory}`;
    const manager = createSidecarLockManager(key);
    const state = managerState(key);
    const entered = deferred();
    const resume = deferred();
    const payload = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
      return { owner: "candidate" };
    });
    const acquiring = manager.acquire({ targetPath: target, staleMs: 30_000, payload });
    await entered.promise;
    expect(state.admissions.size).toBe(1);
    state.admissions.clear();
    resume.resolve();
    await expect(acquiring).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(payload).toHaveBeenCalledOnce();
    expect(state.admissions.size).toBe(0);
    expect(state.held.size).toBe(0);
    await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks held ownership after delayed getters and the late timer hook", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-delayed-holder-");
    const target = path.join(directory, "state.json");
    const normalizedTarget = path.join(fsSync.realpathSync.native(directory), path.basename(target));
    const getterPath = path.join(directory, "getter.lock");
    const latePath = path.join(directory, "late.lock");
    const key = `delayed-holder:${directory}`;
    const manager = createSidecarLockManager(key);
    const state = managerState(key);
    const foreignFromGetter = { owner: "getter" };
    await expect(manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: getterPath,
      payload: async () => ({ owner: "candidate" }),
      timeoutMs: 0,
      retry: { retries: 0 },
      get metadata() {
        state.held.set(normalizedTarget, foreignFromGetter);
        return {};
      },
    })).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(state.held.get(normalizedTarget)).toBe(foreignFromGetter);
    expect(state.admissions.size).toBe(0);
    await expect(fs.access(getterPath)).rejects.toMatchObject({ code: "ENOENT" });
    state.held.clear();

    const foreignFromTimer = { owner: "timer" };
    const timer = {
      unref() {
        state.held.set(normalizedTarget, foreignFromTimer);
      },
    } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockReturnValueOnce(timer);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    await expect(manager.acquire({
      targetPath: target,
      staleMs: 30_000,
      lockPath: latePath,
      payload: async () => ({ owner: "candidate" }),
      timeoutMs: 0,
      retry: { retries: 0 },
      compromiseCheckIntervalMs: 1,
      onCompromised: () => undefined,
    })).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(state.held.get(normalizedTarget)).toBe(foreignFromTimer);
    expect(state.admissions.size).toBe(0);
    await expect(fs.access(latePath)).rejects.toMatchObject({ code: "ENOENT" });
    state.held.clear();
  });
});
