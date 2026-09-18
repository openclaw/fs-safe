import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import type { HeldSidecarLock } from "../src/sidecar-lock-acquire.js";
import {
  createSidecarLockManager,
  type SidecarLockAcquireOptions,
} from "../src/sidecar-lock.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");
type Authority = "raw" | "root";
type ManagerState = {
  admissions: Map<string, object>;
  held: Map<string, HeldSidecarLock>;
};

function managerState(key: string): ManagerState {
  return (Reflect.get(globalThis, managersKey) as Map<string, ManagerState>).get(key)!;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function requiredNativeMode(): "off" | "require" {
  return process.env.FS_SAFE_NATIVE_MODE === "require" ? "require" : "off";
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => { throw new Error("expected acquisition to reject"); },
    (error: unknown) => error,
  );
}

function pauseRawObservation(
  authority: Authority,
  lockPath: string,
  entered: ReturnType<typeof deferred>,
  resume: ReturnType<typeof deferred>,
): void {
  const pause = async (candidate: string) => {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    entered.resolve();
    await resume.promise;
  };
  __setFsSafeTestHooksForTest(authority === "raw"
    ? { beforeSidecarLockSnapshotOpen: pause }
    : { beforeRootReadFinalFence: pause });
}

async function freshProbe(
  manager: ReturnType<typeof createSidecarLockManager>,
  targetPath: string,
  lockRoot: Awaited<ReturnType<typeof root>> | undefined,
): Promise<void> {
  const probe = await manager.acquire({
    targetPath,
    lockRoot,
    staleMs: 30_000,
    timeoutMs: 0,
    retry: { retries: 0 },
    payload: async () => ({ owner: "probe" }),
  });
  expect(await probe.verifyStillHeld()).toBe(true);
  await probe.release();
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

describe("async sidecar admission token currentness", () => {
  it.each(["raw", "root"] as const)(
    "rejects token loss after a suspended retained-holder observation for $authority",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-held-observation-token-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `held-observation-token:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      const state = managerState(key);
      const originalHeld = state.held.get(holder.normalizedTargetPath)!;
      const originalRaw = await fs.readFile(holder.lockPath, "utf8");
      const entered = deferred(), resume = deferred();
      const parser = vi.fn((raw: string) => JSON.parse(raw) as unknown);
      let parserAccessorCalls = 0;
      const options: SidecarLockAcquireOptions<Record<string, unknown>> = {
        targetPath, lockRoot, lockPath: holder.lockPath, staleMs: 30_000,
        timeoutMs: 0, retry: { retries: 0 },
        payload: async () => ({ owner: "candidate" }),
      };
      Object.defineProperty(options, "parsePayload", {
        get() { parserAccessorCalls += 1; return parser; },
      });
      pauseRawObservation(authority, holder.lockPath, entered, resume);
      const acquiring = manager.acquire(options);
      await entered.promise;
      state.admissions.clear();
      resume.resolve();
      try {
        expect(await rejection(acquiring)).toMatchObject({ code: "file_lock_timeout" });
        expect(parserAccessorCalls).toBe(0);
        expect(parser).not.toHaveBeenCalled();
        expect(state.held.get(holder.normalizedTargetPath)).toBe(originalHeld);
        expect(await fs.readFile(holder.lockPath, "utf8")).toBe(originalRaw);
        expect(state.admissions.size).toBe(0);
      } finally {
        resume.resolve();
        __setFsSafeTestHooksForTest();
        await holder.release().catch(() => undefined);
        await acquiring.catch(() => undefined);
      }
      await freshProbe(manager, targetPath, lockRoot);
      await manager.drain();
    },
  );

  it.each(
    (["accessor", "parser"] as const).flatMap((stage) =>
      (["raw", "root"] as const).map((authority) => ({ authority, stage }))),
  )("rejects retained-holder $stage token loss and preserves replacements for $authority",
    async ({ authority, stage }) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-held-parser-token-${stage}-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const unrelatedTarget = path.join(directory, "unrelated.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `held-parser-token:${stage}:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      const state = managerState(key);
      const normalized = holder.normalizedTargetPath;
      const originalHeld = state.held.get(normalized)!;
      const replacement = { lockPath: "replacement" } as HeldSidecarLock;
      const unrelated = { lockPath: "unrelated" } as HeldSidecarLock;
      const loseToken = () => {
        state.admissions.clear();
        state.held.set(normalized, replacement);
        state.held.set(unrelatedTarget, unrelated);
      };
      const parser = vi.fn((raw: string) => {
        if (stage === "parser") loseToken();
        return JSON.parse(raw) as unknown;
      });
      let accessorCalls = 0;
      const options: SidecarLockAcquireOptions<Record<string, unknown>> = {
        targetPath, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
        ...(stage === "parser" ? { lockPath: holder.lockPath } : {}),
        payload: async () => ({ owner: "candidate" }),
      };
      Object.defineProperty(options, "parsePayload", {
        get() {
          accessorCalls += 1;
          if (stage === "accessor") loseToken();
          return parser;
        },
      });
      try {
        expect(await rejection(manager.acquire(options))).toMatchObject({ code: "file_lock_timeout" });
        expect(accessorCalls).toBe(1);
        expect(parser).toHaveBeenCalledTimes(stage === "parser" ? 1 : 0);
        expect(state.held.get(normalized)).toBe(replacement);
        expect(state.held.get(unrelatedTarget)).toBe(unrelated);
        expect(state.admissions.size).toBe(0);
      } finally {
        state.held.set(normalized, originalHeld);
        state.held.delete(unrelatedTarget);
        await holder.release().catch(() => undefined);
      }
      await freshProbe(manager, targetPath, lockRoot);
      await manager.drain();
    });

  it.each(["raw", "root"] as const)(
    "rechecks a retained holder released by its parser accessor for $authority",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-held-parser-release-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `held-parser-release:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      let release: Promise<void> | undefined;
      const parser = vi.fn((raw: string) => JSON.parse(raw) as unknown);
      const options: SidecarLockAcquireOptions<Record<string, unknown>> = {
        targetPath, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
        payload: async () => ({ owner: "candidate" }),
      };
      Object.defineProperty(options, "parsePayload", {
        get() { release ??= holder.release(); return parser; },
      });
      try {
        expect(await rejection(manager.acquire(options))).toMatchObject({ code: "file_lock_timeout" });
        await release;
        expect(parser).not.toHaveBeenCalled();
        expect(managerState(key).held.size).toBe(0);
        expect(managerState(key).admissions.size).toBe(0);
      } finally {
        await release?.catch(() => undefined);
        await holder.release().catch(() => undefined);
      }
      await freshProbe(manager, targetPath, lockRoot);
      await manager.drain();
    },
  );

  it.each(
    (["observation", "accessor", "parser", "reclaim", "removal"] as const).flatMap((stage) =>
      (["raw", "root"] as const).map((authority) => ({ authority, stage }))),
  )("rejects ordinary EEXIST $stage token loss before mutation for $authority",
    async ({ authority, stage }) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-stale-token-${stage}-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockPath = `${targetPath}.lock`;
      const originalRaw = JSON.stringify({ owner: "external" });
      await fs.writeFile(lockPath, originalRaw);
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `stale-token:${stage}:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const state = managerState(key);
      const normalized = path.join(await fs.realpath(directory), path.basename(targetPath));
      const unrelatedTarget = path.join(directory, "unrelated.json");
      const replacement = { lockPath: "replacement" } as HeldSidecarLock;
      const unrelated = { lockPath: "unrelated" } as HeldSidecarLock;
      const entered = deferred(), resume = deferred();
      const loseToken = () => {
        manager.reset();
        state.held.set(normalized, replacement);
        state.held.set(unrelatedTarget, unrelated);
      };
      const suspendAndLose = async () => {
        entered.resolve();
        await resume.promise;
      };
      if (stage === "observation") pauseRawObservation(authority, lockPath, entered, resume);
      const parser = vi.fn((raw: string) => {
        if (stage === "parser") loseToken();
        return JSON.parse(raw) as unknown;
      });
      let accessorCalls = 0;
      const reclaim = vi.fn(async () => {
        if (stage === "reclaim") await suspendAndLose();
        return stage === "removal";
      });
      const remove = vi.fn(async () => {
        if (stage === "removal") await suspendAndLose();
        return true;
      });
      const options: SidecarLockAcquireOptions<Record<string, unknown>> = {
        targetPath, lockRoot, staleMs: 0, timeoutMs: 0, retry: { retries: 0 },
        payload: async () => ({ owner: "candidate" }),
        shouldReclaim: reclaim,
        staleRecovery: "remove-if-unchanged",
        shouldRemoveStaleLock: remove,
      };
      Object.defineProperty(options, "parsePayload", {
        get() {
          accessorCalls += 1;
          if (stage === "accessor") loseToken();
          return parser;
        },
      });
      const acquiring = manager.acquire(options);
      if (stage === "observation" || stage === "reclaim" || stage === "removal") {
        await entered.promise;
        loseToken();
        resume.resolve();
      }
      try {
        expect(await rejection(acquiring)).toMatchObject({ code: "file_lock_timeout" });
        expect(state.held.get(normalized)).toBe(replacement);
        expect(state.held.get(unrelatedTarget)).toBe(unrelated);
        expect(state.admissions.size).toBe(0);
        expect(await fs.readFile(lockPath, "utf8")).toBe(originalRaw);
        await expect(fs.access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
        expect(accessorCalls).toBe(stage === "observation" ? 0 : 1);
        if (stage === "accessor") expect(parser).not.toHaveBeenCalled();
        if (stage === "observation" || stage === "accessor" || stage === "parser") {
          expect(reclaim).not.toHaveBeenCalled();
        }
        if (stage !== "removal") expect(remove).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        __setFsSafeTestHooksForTest();
        state.held.delete(normalized);
        state.held.delete(unrelatedTarget);
        await acquiring.catch(() => undefined);
        await fs.rm(lockPath, { force: true });
      }
      await freshProbe(manager, targetPath, lockRoot);
      await manager.drain();
    });
});
