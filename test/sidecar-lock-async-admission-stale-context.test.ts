import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { createSidecarLockManager, type SidecarLockHandle } from "../src/sidecar-lock.js";
import type { HeldSidecarLock } from "../src/sidecar-lock-acquire.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

type ManagerState = {
  admissions: Map<string, object>;
  held: Map<string, HeldSidecarLock>;
};

function managerState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
    string,
    ManagerState
  >;
  return managers.get(key)!;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => { throw new Error("expected acquisition to reject"); },
    (error: unknown) => error,
  );
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
});

describe("async stale-policy admission ancestry", () => {
  it("filters an inactive child while retaining its active ancestor snapshot", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-inactive-child-active-ancestor-");
    const targetA = path.join(directory, "a.json");
    const targetB = path.join(directory, "b.json");
    const targetC = path.join(directory, "c.json");
    const key = `inactive-child-active-ancestor:${directory}`;
    const manager = createSidecarLockManager(key);
    vi.resetModules();
    const reloaded = (await import("../src/sidecar-lock.js")).createSidecarLockManager(key);
    const during = deferred();
    const after = deferred();
    const nestedPayload = vi.fn(async () => ({ owner: "nested-a" }));
    let whileAncestorActive: Promise<void> | undefined;
    let afterAncestorReleased: Promise<SidecarLockHandle> | undefined;
    let nestedError: unknown;
    const outer = await manager.acquire({
      targetPath: targetA, staleMs: 30_000,
      payload: async () => {
        const middle = await manager.acquire({
          targetPath: targetB, staleMs: 30_000,
          payload: async () => {
            whileAncestorActive = Promise.resolve().then(async () => {
              await during.promise;
              nestedError = await rejection(reloaded.acquire({
                targetPath: targetA, staleMs: 30_000,
                timeoutMs: Number.POSITIVE_INFINITY, retry: {}, payload: nestedPayload,
              }));
              const reacquiredB = await manager.acquire({
                targetPath: targetB, staleMs: 30_000,
                payload: async () => ({ owner: "new-b" }),
              });
              const unrelated = await manager.acquire({
                targetPath: targetC, staleMs: 30_000,
                payload: async () => ({ owner: "c" }),
              });
              await unrelated.release();
              await reacquiredB.release();
            });
            afterAncestorReleased = Promise.resolve().then(async () => {
              await after.promise;
              return await reloaded.acquire({
                targetPath: targetA, staleMs: 30_000,
                payload: async () => ({ owner: "after-a" }),
              });
            });
            return { owner: "middle-b" };
          },
        });
        await middle.release();
        during.resolve();
        await whileAncestorActive;
        return { owner: "outer-a" };
      },
    });
    expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
    expect(nestedPayload).not.toHaveBeenCalled();
    await outer.release();
    after.resolve();
    const detached = await afterAncestorReleased!;
    try {
      expect(await detached.verifyStillHeld()).toBe(true);
    } finally {
      await detached.release();
      await manager.drain();
      await reloaded.drain();
    }
  });

  it.each(["parsePayload", "shouldReclaim", "shouldRemoveStaleLock"] as const)(
    "scopes %s cycles and preserves cleanup",
    async (stage) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-stale-cycle-${stage}-`);
      const targetPath = path.join(directory, "state.json");
      const lockPath = `${targetPath}.lock`;
      const nestedLockPath = path.join(directory, "nested.lock");
      const original = JSON.stringify({ owner: "external" });
      await fs.writeFile(lockPath, original);
      const key = `stale-cycle:${stage}:${directory}`;
      const manager = createSidecarLockManager(key);
      const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
      let nested: Promise<SidecarLockHandle> | undefined;
      let nestedError: unknown;
      let launchCompletion: Promise<void> | undefined;
      const launch = async () => {
        nested ??= manager.acquire({
          targetPath,
          lockPath: nestedLockPath,
          staleMs: 30_000,
          timeoutMs: Number.POSITIVE_INFINITY,
          retry: {},
          payload: nestedPayload,
        });
        nestedError = await rejection(nested);
      };
      const options = {
        targetPath,
        staleMs: 0,
        timeoutMs: 0,
        retry: { retries: 0 },
        payload: async () => ({ owner: "candidate" }),
        ...(stage === "parsePayload" ? {
          parsePayload: (raw: string) => {
            launchCompletion ??= launch();
            return JSON.parse(raw) as unknown;
          },
          shouldReclaim: async () => false,
        } : stage === "shouldReclaim" ? {
          shouldReclaim: async () => { await launch(); return false; },
        } : {
          shouldReclaim: async () => true,
          staleRecovery: "remove-if-unchanged" as const,
          shouldRemoveStaleLock: async () => { await launch(); return false; },
        }),
      };
      const outerError = await rejection(manager.acquire(options));
      await launchCompletion;
      expect(outerError).toMatchObject({
        code: stage === "shouldRemoveStaleLock" ? "file_lock_stale" : "file_lock_timeout",
      });
      expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(managerState(key).admissions.size).toBe(0);
      expect(managerState(key).held.size).toBe(0);
      expect(await fs.readFile(lockPath, "utf8")).toBe(original);
      await manager.drain();
    },
  );

  it("preserves an awaited release failure and clears the callback admission", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-context-release-failure-");
    const targetPath = path.join(directory, "state.json");
    const key = `context-release-failure:${directory}`;
    const manager = createSidecarLockManager(key);
    const holder = await manager.acquire({
      targetPath,
      staleMs: 30_000,
      payload: async () => ({ owner: "holder" }),
    });
    const releaseError = new Error("release failed");
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(releaseError);
    try {
      const failed = manager.acquire({
        targetPath,
        staleMs: 30_000,
        reentrantOwner: "candidate",
        payload: async () => {
          await holder.release();
          return { owner: "candidate" };
        },
      });
      expect(await rejection(failed)).toBe(releaseError);
      expect(managerState(key).admissions.size).toBe(0);
      expect(managerState(key).held.size).toBe(1);
    } finally {
      remove.mockRestore();
      await manager.drain();
    }
    expect(managerState(key).held.size).toBe(0);
  });
});
