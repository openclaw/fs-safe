import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");
type Authority = "raw" | "root";
type ManagerState = { admissions: Map<string, object>; held: Map<string, unknown> };

function requiredNativeMode(): "off" | "require" {
  return process.env.FS_SAFE_NATIVE_MODE === "require" ? "require" : "off";
}

function state(key: string): ManagerState {
  return (Reflect.get(globalThis, managersKey) as Map<string, ManagerState>).get(key)!;
}

function zeroDelay(): void {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, _delay, ...args) => {
    queueMicrotask(() => Reflect.apply(callback, undefined, args));
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

describe("per-attempt asynchronous parser compatibility", () => {
  it.each(
    (["raw", "root"] as const).flatMap((authority) =>
      [false, true].map((explicitSame) => ({ authority, explicitSame }))),
  )("reads the byte-first $authority parser accessor on every retry (explicit same: $explicitSame)",
    async ({ authority, explicitSame }) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-parser-attempt-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `parser-attempt:${authority}:${explicitSame}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      const raw = await fs.readFile(holder.lockPath, "utf8");
      const order: string[] = [];
      const parsers = Array.from({ length: 4 }, (_, index) => vi.fn((value: string) => {
        order.push(`parse:${index}`);
        expect(value).toBe(raw);
        return { attempt: index };
      }));
      let accessorCalls = 0;
      __setFsSafeTestHooksForTest(authority === "raw"
        ? { beforeSidecarLockSnapshotOpen: (candidate) => {
            if (candidate === holder.lockPath) order.push("observe");
          } }
        : { beforeRootReadFinalFence: (candidate) => {
            if (candidate === holder.lockPath) order.push("observe");
          } });
      const options = {
        targetPath, lockRoot, staleMs: 30_000, timeoutMs: Number.POSITIVE_INFINITY,
        retry: { retries: 3, minTimeout: 0, maxTimeout: 0 },
        payload: async () => ({
          toJSON() { order.push("serialize"); return { owner: "candidate" }; },
        }),
      };
      Object.defineProperty(options, "payload", { value: async () => {
        order.push("payload");
        return { toJSON() { order.push("serialize"); return { owner: "candidate" }; } };
      } });
      Object.defineProperty(options, "parsePayload", { get() {
        const index = accessorCalls++;
        order.push(`accessor:${index}`);
        return parsers[index];
      } });
      if (explicitSame) Reflect.set(options, "lockPath", holder.lockPath);
      zeroDelay();
      try {
        await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
        expect(order).toEqual(Array.from({ length: 4 }, (_, index) => [
          "payload", "serialize", "observe", `accessor:${index}`, `parse:${index}`,
        ]).flat());
        expect(accessorCalls).toBe(4);
        for (const parser of parsers) expect(parser).toHaveBeenCalledOnce();
        expect(state(key).admissions.size).toBe(0);
      } finally {
        __setFsSafeTestHooksForTest();
        await holder.release().catch(() => undefined);
        await manager.drain();
      }
    });

  it.each(["raw", "root"] as const)(
    "preserves a second-attempt $authority parser accessor failure",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-parser-second-throw-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `parser-second-throw:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      const failure = Object.assign(new Error("second parser access failed"), { code: "EEXIST" });
      const parser = vi.fn((raw: string) => JSON.parse(raw) as unknown);
      let accesses = 0;
      const options = {
        targetPath, lockRoot, staleMs: 30_000, timeoutMs: Number.POSITIVE_INFINITY,
        retry: { retries: 3, minTimeout: 0, maxTimeout: 0 },
        payload: vi.fn(async () => ({ owner: "candidate" })),
      };
      Object.defineProperty(options, "parsePayload", { get() {
        accesses += 1;
        if (accesses === 2) throw failure;
        return parser;
      } });
      zeroDelay();
      try {
        expect(await manager.acquire(options).then(() => undefined, (error) => error)).toBe(failure);
        expect(accesses).toBe(2);
        expect(parser).toHaveBeenCalledOnce();
        expect(options.payload).toHaveBeenCalledTimes(2);
        expect(state(key).admissions.size).toBe(0);
      } finally {
        await holder.release().catch(() => undefined);
        await manager.drain();
      }
    });

  it.each(["raw", "root"] as const)(
    "does not classify a fresh $authority parser accessor EEXIST as create contention",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-parser-eexist-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `parser-eexist:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const failure = Object.assign(new Error("parser accessor owns this EEXIST"), { code: "EEXIST" });
      const reclaim = vi.fn(async () => true);
      const options = {
        targetPath, lockRoot, staleMs: 0, timeoutMs: Number.POSITIVE_INFINITY,
        retry: { retries: 3, minTimeout: 0, maxTimeout: 0 },
        payload: async () => ({ owner: "candidate" }), shouldReclaim: reclaim,
      };
      let accesses = 0;
      Object.defineProperty(options, "parsePayload", { get() { accesses += 1; throw failure; } });
      const timer = vi.spyOn(globalThis, "setTimeout");
      expect(await manager.acquire(options).then(() => undefined, (error) => error)).toBe(failure);
      expect(accesses).toBe(1);
      expect(reclaim).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      expect(state(key).admissions.size).toBe(0);
      expect(state(key).held.size).toBe(0);
      await expect(fs.access(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      await manager.drain();
    });

  it("keeps cleanup primary when parser-access EEXIST and owned cleanup both fail", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-parser-eexist-cleanup-");
    const targetPath = path.join(directory, "state.json");
    const manager = createSidecarLockManager(`parser-eexist-cleanup:${directory}`);
    const acquisition = Object.assign(new Error("parser EEXIST"), { code: "EEXIST" });
    const cleanup = new Error("owned cleanup failed");
    const options = {
      targetPath, staleMs: 30_000, payload: async () => ({ owner: "candidate" }),
    };
    Object.defineProperty(options, "parsePayload", { get() { throw acquisition; } });
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanup);
    const error = await manager.acquire(options).then(() => undefined, (reason) => reason) as {
      error: unknown; suppressed: unknown;
    };
    expect(error).toMatchObject({ name: "SuppressedError" });
    expect(error.error).toBe(cleanup);
    expect(error.suppressed).toBe(acquisition);
    remove.mockRestore();
    await fs.rm(`${targetPath}.lock`, { force: true });
    await manager.drain();
  });

  it.each(
    (["raw", "root"] as const).flatMap((authority) =>
      (["token", "holder"] as const).map((loss) => ({ authority, loss }))),
  )("uses receipt-only $authority cleanup after late $loss loss", async ({ authority, loss }) => {
    configureFsSafeNative({ mode: requiredNativeMode() });
    const directory = await tempRoot(`fs-safe-parser-cleanup-authority-${authority}-${loss}-`);
    const targetPath = path.join(directory, "state.json");
    const lockRoot = authority === "root" ? await root(directory) : undefined;
    const key = `parser-cleanup-authority:${authority}:${loss}:${directory}`;
    const manager = createSidecarLockManager(key);
    const managerState = state(key);
    const normalized = path.join(await fs.realpath(directory), path.basename(targetPath));
    const replacement = { lockPath: "replacement" };
    const parser = vi.fn((raw: string) => JSON.parse(raw) as unknown);
    let parserAccesses = 0;
    const options = {
      targetPath, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
      payload: async () => ({ owner: "candidate" }), compromiseCheckIntervalMs: 1,
      onCompromised: () => undefined,
    };
    Object.defineProperty(options, "parsePayload", { get() {
      parserAccesses += 1;
      return parser;
    } });
    const timer = { unref() {
      if (loss === "token") managerState.admissions.clear();
      else managerState.held.set(normalized, replacement);
    } } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockReturnValueOnce(timer);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(parserAccesses).toBe(1);
    expect(parser).not.toHaveBeenCalled();
    if (loss === "holder") expect(managerState.held.get(normalized)).toBe(replacement);
    else expect(managerState.held.has(normalized)).toBe(false);
    expect(managerState.admissions.size).toBe(0);
    await expect(fs.access(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    managerState.held.delete(normalized);
    await manager.drain();
  });

  it("runs authorized cleanup parsing inside the active ancestry scope", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-parser-cleanup-scope-");
    const targetPath = path.join(directory, "state.json");
    const key = `parser-cleanup-scope:${directory}`;
    const manager = createSidecarLockManager(key);
    const setupFailure = new Error("timer setup failed");
    const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
    let nested: Promise<unknown> | undefined;
    const parser = vi.fn((raw: string) => {
      nested = manager.acquire({
        targetPath, staleMs: 30_000, timeoutMs: Number.POSITIVE_INFINITY,
        retry: {}, payload: nestedPayload,
      }).then((handle) => handle, (error) => error);
      return JSON.parse(raw) as unknown;
    });
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce((() => {
      throw setupFailure;
    }) as typeof setInterval);
    const error = await manager.acquire({
      targetPath, staleMs: 30_000, payload: async () => ({ owner: "candidate" }),
      parsePayload: parser, compromiseCheckIntervalMs: 1, onCompromised: () => undefined,
    }).then(() => undefined, (reason) => reason);
    expect(error).toBe(setupFailure);
    expect(await nested).toMatchObject({ code: "file_lock_timeout" });
    expect(parser).toHaveBeenCalledOnce();
    expect(nestedPayload).not.toHaveBeenCalled();
    expect(state(key).admissions.size).toBe(0);
    expect(state(key).held.size).toBe(0);
    await manager.drain();
  });

  it("keeps an authorized cleanup-parser failure primary", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-parser-cleanup-suppressed-");
    const targetPath = path.join(directory, "state.json");
    const manager = createSidecarLockManager(`parser-cleanup-suppressed:${directory}`);
    const acquisition = new Error("timer setup failed");
    const cleanup = new Error("cleanup parser failed");
    const parser = vi.fn(() => { throw cleanup; });
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce((() => {
      throw acquisition;
    }) as typeof setInterval);
    const error = await manager.acquire({
      targetPath, staleMs: 30_000, payload: async () => ({ owner: "candidate" }),
      parsePayload: parser, compromiseCheckIntervalMs: 1, onCompromised: () => undefined,
    }).then(() => undefined, (reason) => reason) as { error: unknown; suppressed: unknown };
    expect(error).toMatchObject({ name: "SuppressedError" });
    expect(error.error).toBe(cleanup);
    expect(error.suppressed).toBe(acquisition);
    expect(parser).toHaveBeenCalledOnce();
    expect(state(`parser-cleanup-suppressed:${directory}`).admissions.size).toBe(0);
    await fs.rm(`${targetPath}.lock`, { force: true });
    await manager.drain();
  });
});
