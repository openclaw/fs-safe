import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import type { HeldSidecarLock } from "../src/sidecar-lock-acquire.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");
type Authority = "raw" | "root";
type Loss = "token" | "holder";
type ManagerState = {
  admissions: Map<string, object>;
  held: Map<string, HeldSidecarLock>;
};

function managerState(key: string): ManagerState {
  return (Reflect.get(globalThis, managersKey) as Map<string, ManagerState>).get(key)!;
}

function requiredNativeMode(): "off" | "require" {
  return process.env.FS_SAFE_NATIVE_MODE === "require" ? "require" : "off";
}

async function freshProbe(
  manager: ReturnType<typeof createSidecarLockManager>,
  targetPath: string,
  lockRoot: Awaited<ReturnType<typeof root>> | undefined,
): Promise<void> {
  const probe = await manager.acquire({
    targetPath, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
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

describe("async sidecar admission boundary currentness", () => {
  it.each(
    (["raw", "root"] as const).flatMap((authority) =>
      (["token", "holder"] as const).flatMap((loss) =>
        (["metadata", "onCompromised"] as const).map((stage) => ({ authority, loss, stage })))),
  )("stops after $loss loss from the $stage getter for $authority", async ({ authority, loss, stage }) => {
    configureFsSafeNative({ mode: requiredNativeMode() });
    const directory = await tempRoot(`fs-safe-option-boundary-${stage}-${loss}-${authority}-`);
    const targetPath = path.join(directory, "state.json");
    const lockRoot = authority === "root" ? await root(directory) : undefined;
    const key = `option-boundary:${stage}:${loss}:${authority}:${directory}`;
    const manager = createSidecarLockManager(key);
    const state = managerState(key);
    const normalized = path.join(await fs.realpath(directory), path.basename(targetPath));
    const replacement = { lockPath: "replacement" } as HeldSidecarLock;
    const unrelatedPath = path.join(directory, "unrelated.json");
    const unrelated = { lockPath: "unrelated" } as HeldSidecarLock;
    const mutate = () => {
      if (loss === "token") state.admissions.clear();
      else state.held.set(normalized, replacement);
      state.held.set(unrelatedPath, unrelated);
    };
    let metadataAccesses = 0, compromisedAccesses = 0, parserAccesses = 0;
    const options = {
      targetPath, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
      payload: async () => ({ owner: "candidate" }),
    };
    Object.defineProperty(options, "metadata", { get() {
      metadataAccesses += 1;
      if (stage === "metadata") mutate();
      return {};
    } });
    Object.defineProperty(options, "onCompromised", { get() {
      compromisedAccesses += 1;
      if (stage === "onCompromised") mutate();
      return () => undefined;
    } });
    Object.defineProperty(options, "parsePayload", { get() {
      parserAccesses += 1;
      return JSON.parse;
    } });
    await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(metadataAccesses).toBe(1);
    expect(compromisedAccesses).toBe(stage === "onCompromised" ? 1 : 0);
    expect(parserAccesses).toBe(0);
    expect(state.held.get(unrelatedPath)).toBe(unrelated);
    if (loss === "holder") expect(state.held.get(normalized)).toBe(replacement);
    else expect(state.held.has(normalized)).toBe(false);
    expect(state.admissions.size).toBe(0);
    await expect(fs.access(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    state.held.delete(normalized);
    state.held.delete(unrelatedPath);
    await freshProbe(manager, targetPath, lockRoot);
    await manager.drain();
  });

  const staleStages = [
    "observation", "parserAccessor", "parserCallback", "shouldReclaimGetter",
    "shouldRemoveGetter", "staleRecoveryGetter", "reclaimCallback",
    "revalidation", "removalCallback",
  ] as const;

  it.each(
    (["raw", "root"] as const).flatMap((authority) =>
      (["token", "holder"] as const).flatMap((loss) =>
        staleStages.map((stage) => ({ authority, loss, stage })))),
  )("stops stale admission after $loss loss at $stage for $authority",
    async ({ authority, loss, stage }) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-stale-boundary-${stage}-${loss}-${authority}-`);
      const targetPath = path.join(directory, "state.json");
      const lockPath = `${targetPath}.lock`;
      const originalRaw = JSON.stringify({ owner: "external" });
      await fs.writeFile(lockPath, originalRaw);
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `stale-boundary:${stage}:${loss}:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const state = managerState(key);
      const normalized = path.join(await fs.realpath(directory), path.basename(targetPath));
      const replacement = { lockPath: "replacement" } as HeldSidecarLock;
      const unrelatedPath = path.join(directory, "unrelated.json");
      const unrelated = { lockPath: "unrelated" } as HeldSidecarLock;
      let mutated = false;
      const mutate = () => {
        if (mutated) return;
        mutated = true;
        if (loss === "token") state.admissions.clear();
        else state.held.set(normalized, replacement);
        state.held.set(unrelatedPath, unrelated);
      };
      let observations = 0, parserAccesses = 0;
      const parser = vi.fn((raw: string) => {
        if (stage === "parserCallback") mutate();
        return JSON.parse(raw) as unknown;
      });
      const reclaim = vi.fn(async () => {
        if (stage === "reclaimCallback") mutate();
        return true;
      });
      const remove = vi.fn(async () => {
        if (stage === "removalCallback") mutate();
        return true;
      });
      const observe = (candidate: string) => {
        if (candidate !== lockPath) return;
        observations += 1;
        if (stage === "observation" && observations === 1) mutate();
        if (stage === "revalidation" && observations === 2) mutate();
      };
      __setFsSafeTestHooksForTest(authority === "raw"
        ? { beforeSidecarLockSnapshotOpen: observe }
        : { beforeRootReadFinalFence: observe });
      let reclaimAccesses = 0, removeAccesses = 0, recoveryAccesses = 0;
      const options = {
        targetPath, lockRoot, staleMs: 0, timeoutMs: 0, retry: { retries: 0 },
        payload: async () => ({ owner: "candidate" }),
      };
      Object.defineProperty(options, "parsePayload", { get() {
        parserAccesses += 1;
        if (stage === "parserAccessor") mutate();
        return parser;
      } });
      Object.defineProperty(options, "shouldReclaim", { get() {
        reclaimAccesses += 1;
        if (stage === "shouldReclaimGetter") mutate();
        return reclaim;
      } });
      Object.defineProperty(options, "shouldRemoveStaleLock", { get() {
        removeAccesses += 1;
        if (stage === "shouldRemoveGetter") mutate();
        return remove;
      } });
      Object.defineProperty(options, "staleRecovery", { get() {
        recoveryAccesses += 1;
        if (stage === "staleRecoveryGetter") mutate();
        return "remove-if-unchanged" as const;
      } });
      try {
        await expect(manager.acquire(options)).rejects.toMatchObject({ code: "file_lock_timeout" });
        expect(mutated).toBe(true);
        expect(parserAccesses).toBe(stage === "observation" ? 0 : 1);
        const expectedParses = stage === "observation" || stage === "parserAccessor" ? 0
          : stage === "revalidation" ? 1 : stage === "removalCallback" ? 3 : 1;
        expect(parser).toHaveBeenCalledTimes(expectedParses);
        const getterStage = staleStages.indexOf(stage);
        const firstGetter = staleStages.indexOf("shouldReclaimGetter");
        expect(reclaimAccesses).toBe(getterStage >= firstGetter ? 1 : 0);
        expect(removeAccesses).toBe(getterStage >= staleStages.indexOf("shouldRemoveGetter") ? 1 : 0);
        expect(recoveryAccesses).toBe(getterStage >= staleStages.indexOf("staleRecoveryGetter") ? 1 : 0);
        expect(reclaim).toHaveBeenCalledTimes(
          (["reclaimCallback", "revalidation", "removalCallback"] as string[]).includes(stage) ? 1 : 0,
        );
        expect(remove).toHaveBeenCalledTimes(stage === "removalCallback" ? 1 : 0);
        expect(state.held.get(unrelatedPath)).toBe(unrelated);
        if (loss === "holder") expect(state.held.get(normalized)).toBe(replacement);
        else expect(state.held.has(normalized)).toBe(false);
        expect(state.admissions.size).toBe(0);
        expect(await fs.readFile(lockPath, "utf8")).toBe(originalRaw);
        await expect(fs.access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        __setFsSafeTestHooksForTest();
        state.held.delete(normalized);
        state.held.delete(unrelatedPath);
        await fs.rm(lockPath, { force: true });
      }
      await freshProbe(manager, targetPath, lockRoot);
      await manager.drain();
    });
});
