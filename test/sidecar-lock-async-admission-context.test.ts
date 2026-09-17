import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import {
  createSidecarLockManager,
  type SidecarLockHandle,
} from "../src/sidecar-lock.js";
import type { HeldSidecarLock } from "../src/sidecar-lock-acquire.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");

type ManagerState = {
  admissions: Map<string, object>;
  held: Map<string, HeldSidecarLock>;
};

type LockSettlement =
  | { status: "fulfilled"; handle: SidecarLockHandle }
  | { status: "rejected"; reason: unknown };

function managerState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, managersKey) as Map<string, ManagerState>;
  return managers.get(key)!;
}

function deferred(): { promise: Promise<void>; reject(error: unknown): void; resolve(): void } {
  let reject!: (error: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => { throw new Error("expected acquisition to reject"); },
    (error: unknown) => error,
  );
}

function expectedTarget(directory: string, targetPath: string): string {
  return path.join(fsSync.realpathSync.native(directory), path.basename(targetPath));
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
});

describe("async sidecar admission callback ancestry", () => {
  it.each([
    { authority: "raw", mode: "off", stage: "before-await" },
    { authority: "raw", mode: "auto", stage: "after-await" },
    { authority: "root", mode: "off", stage: "after-await" },
    { authority: "root", mode: "auto", stage: "before-await" },
  ] as const)(
    "rejects unbounded $authority/$mode payload reentry $stage without backoff",
    async ({ authority, mode, stage }) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot(`fs-safe-async-cycle-${authority}-${mode}-`);
      const targetPath = path.join(directory, "state.json");
      const nestedLockPath = path.join(directory, "nested.lock");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `async-cycle:${authority}:${mode}:${directory}`;
      const manager = createSidecarLockManager(key);
      const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
      let nestedError: unknown;
      let outer: SidecarLockHandle | undefined;
      try {
        outer = await manager.acquire({
          targetPath,
          lockPath: path.join(directory, "outer.lock"),
          lockRoot,
          staleMs: 30_000,
          payload: async () => {
            if (stage === "after-await") await Promise.resolve();
            nestedError = await rejection(manager.acquire({
              targetPath: path.join(directory, ".", "state.json"),
              lockPath: nestedLockPath,
              lockRoot,
              staleMs: 30_000,
              timeoutMs: Number.POSITIVE_INFINITY,
              retry: {},
              payload: nestedPayload,
            }));
            return { owner: "outer" };
          },
        });
        expect(nestedError).toMatchObject({
          code: "file_lock_timeout",
          lockPath: nestedLockPath,
          normalizedTargetPath: expectedTarget(directory, targetPath),
        });
        expect(nestedPayload).not.toHaveBeenCalled();
        expect(managerState(key).admissions.size).toBe(0);
        expect(managerState(key).held.size).toBe(1);
      } finally {
        await outer?.release().catch(() => undefined);
        await manager.drain();
      }
      expect(managerState(key).held.size).toBe(0);
    },
  );

  it.each(["payload-accessor", "metadata", "onCompromised", "parsePayload"] as const)(
    "keeps %s getter reentry inside the reservation scope",
    async (stage) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-getter-cycle-${stage}-`);
      const targetPath = path.join(directory, "state.json");
      const nestedLockPath = path.join(directory, "nested.lock");
      const key = `getter-cycle:${stage}:${directory}`;
      const manager = createSidecarLockManager(key);
      const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
      let nested: Promise<LockSettlement> | undefined;
      const launch = () => {
        nested ??= manager.acquire({
          targetPath,
          lockPath: nestedLockPath,
          staleMs: 30_000,
          timeoutMs: Number.POSITIVE_INFINITY,
          retry: {},
          payload: nestedPayload,
        }).then<LockSettlement, LockSettlement>(
          (handle) => ({ status: "fulfilled", handle }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
      };
      const options = {
        targetPath,
        lockPath: path.join(directory, "outer.lock"),
        staleMs: 30_000,
        payload: () => ({ owner: "outer" }),
      };
      if (stage === "payload-accessor") {
        Object.defineProperty(options, "payload", {
          get: () => { launch(); return () => ({ owner: "outer" }); },
        });
      } else {
        Object.defineProperty(options, stage, {
          get: () => {
            launch();
            if (stage === "metadata") return {};
            if (stage === "onCompromised") return () => undefined;
            return (raw: string) => JSON.parse(raw) as unknown;
          },
        });
      }
      let outer: SidecarLockHandle | undefined;
      try {
        outer = await manager.acquire(options);
        expect(nested).toBeDefined();
        const nestedSettlement = await nested!;
        expect(nestedSettlement.status).toBe("rejected");
        if (nestedSettlement.status === "rejected") {
          expect(nestedSettlement.reason).toMatchObject({
            code: "file_lock_timeout",
            lockPath: nestedLockPath,
            normalizedTargetPath: expectedTarget(directory, targetPath),
          });
        }
        expect(nestedPayload).not.toHaveBeenCalled();
        expect(managerState(key).admissions.size).toBe(0);
        expect(managerState(key).held.size).toBe(1);
      } finally {
        const nestedSettlement = nested === undefined ? undefined : await nested;
        if (nestedSettlement?.status === "fulfilled") {
          await nestedSettlement.handle.release().catch(() => undefined);
        }
        await outer?.release().catch(() => undefined);
        await manager.drain();
      }
      expect(managerState(key).held.size).toBe(0);
    },
  );

  it("retains ancestry captured by toJSON while target normalization is delayed", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-json-normalization-cycle-");
    const targetPath = path.join(directory, "state.json");
    const nestedLockPath = path.join(directory, "nested.lock");
    const lockRoot = await root(directory);
    const originalResolve = lockRoot.resolve.bind(lockRoot);
    const childEntered = deferred();
    const resumeChild = deferred();
    let resolveCalls = 0;
    vi.spyOn(lockRoot, "resolve").mockImplementation(async (relativePath) => {
      resolveCalls += 1;
      if (resolveCalls === 3) {
        childEntered.resolve();
        await resumeChild.promise;
      }
      return await originalResolve(relativePath);
    });
    const key = `json-normalization-cycle:${directory}`;
    const manager = createSidecarLockManager(key);
    const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
    let nested: Promise<SidecarLockHandle> | undefined;
    let outer: SidecarLockHandle | undefined;
    try {
      outer = await manager.acquire({
        targetPath,
        lockPath: path.join(directory, "outer.lock"),
        lockRoot,
        staleMs: 30_000,
        payload: async () => ({
          toJSON() {
            nested = manager.acquire({
              targetPath,
              lockPath: nestedLockPath,
              lockRoot,
              staleMs: 30_000,
              timeoutMs: Number.POSITIVE_INFINITY,
              retry: {},
              payload: nestedPayload,
            });
            return { owner: "outer" };
          },
        }),
      });
      await childEntered.promise;
      resumeChild.resolve();
      expect(await rejection(nested!)).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(managerState(key).admissions.size).toBe(0);
    } finally {
      resumeChild.resolve();
      await nested?.catch(() => undefined);
      await outer?.release().catch(() => undefined);
      await manager.drain();
    }
  });

  it("preserves the full A-to-B-to-A ancestry chain", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-aba-cycle-");
    const targetA = path.join(directory, "a.json");
    const targetB = path.join(directory, "b.json");
    const key = `aba-cycle:${directory}`;
    const manager = createSidecarLockManager(key);
    const innermostPayload = vi.fn(async () => ({ owner: "inner-a" }));
    let innermostError: unknown;
    let outer: SidecarLockHandle | undefined;
    try {
      outer = await manager.acquire({
        targetPath: targetA,
        staleMs: 30_000,
        payload: async () => {
          const middle = await manager.acquire({
            targetPath: targetB,
            staleMs: 30_000,
            payload: async () => {
              innermostError = await rejection(manager.acquire({
                targetPath: targetA,
                lockPath: path.join(directory, "inner-a.lock"),
                staleMs: 30_000,
                timeoutMs: Number.POSITIVE_INFINITY,
                retry: {},
                payload: innermostPayload,
              }));
              return { owner: "middle-b" };
            },
          });
          await middle.release();
          return { owner: "outer-a" };
        },
      });
      expect(innermostError).toMatchObject({ code: "file_lock_timeout" });
      expect(innermostPayload).not.toHaveBeenCalled();
      expect(managerState(key).admissions.size).toBe(0);
    } finally {
      await outer?.release().catch(() => undefined);
      await manager.drain();
    }
  });

  it.each(["different-target", "different-domain"] as const)(
    "does not reject a nested %s acquisition",
    async (kind) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-async-distinct-${kind}-`);
      const targetPath = path.join(directory, "state.json");
      const outerKey = `distinct-outer:${kind}:${directory}`;
      const outerManager = createSidecarLockManager(outerKey);
      const nestedManager = kind === "different-domain"
        ? createSidecarLockManager(`distinct-inner:${directory}`)
        : outerManager;
      const nestedTarget = kind === "different-target"
        ? path.join(directory, "other.json")
        : targetPath;
      const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
      let outer: SidecarLockHandle | undefined;
      try {
        outer = await outerManager.acquire({
          targetPath,
          lockPath: path.join(directory, "outer.lock"),
          staleMs: 30_000,
          payload: async () => {
            const nested = await nestedManager.acquire({
              targetPath: nestedTarget,
              lockPath: path.join(directory, "nested.lock"),
              staleMs: 30_000,
              payload: nestedPayload,
            });
            await nested.release();
            return { owner: "outer" };
          },
        });
        expect(nestedPayload).toHaveBeenCalledOnce();
        expect(managerState(outerKey).admissions.size).toBe(0);
      } finally {
        await outer?.release().catch(() => undefined);
        await outerManager.drain();
        await nestedManager.drain();
      }
    },
  );

  it("allows independent contention and completed same-owner reuse", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-independent-");
    const targetPath = path.join(directory, "state.json");
    const key = `independent:${directory}`;
    const manager = createSidecarLockManager(key);
    const entered = deferred();
    const resume = deferred();
    let outer: SidecarLockHandle | undefined;
    let contender: SidecarLockHandle | undefined;
    const outerAcquisition = manager.acquire({
      targetPath,
      staleMs: 30_000,
      reentrantOwner: "outer",
      payload: async () => { entered.resolve(); await resume.promise; return { owner: "outer" }; },
    });
    await entered.promise;
    const contenderAcquisition = manager.acquire({
      targetPath,
      staleMs: 30_000,
      timeoutMs: 2_000,
      retry: { minTimeout: 1, maxTimeout: 1 },
      payload: async () => ({ owner: "contender" }),
    });
    resume.resolve();
    try {
      outer = await outerAcquisition;
      const reentrant = await manager.acquire({
        targetPath,
        staleMs: 30_000,
        reentrantOwner: "outer",
        payload: async () => ({ unused: true }),
      });
      await reentrant.release();
      await outer.release();
      outer = undefined;
      contender = await contenderAcquisition;
      expect(await contender.verifyStillHeld()).toBe(true);
    } finally {
      resume.resolve();
      await outer?.release().catch(() => undefined);
      await contender?.release().catch(() => undefined);
      await contenderAcquisition.catch(() => undefined);
      await manager.drain();
    }
  });

  it("shares ancestry across reloaded package wrappers", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-package-copy-");
    const targetPath = path.join(directory, "state.json");
    const key = `package-copy:${directory}`;
    const first = createSidecarLockManager(key);
    vi.resetModules();
    const secondModule = await import("../src/sidecar-lock.js");
    const second = secondModule.createSidecarLockManager(key);
    const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
    let nestedError: unknown;
    let outer: SidecarLockHandle | undefined;
    try {
      outer = await first.acquire({
        targetPath,
        staleMs: 30_000,
        payload: async () => {
          nestedError = await rejection(second.acquire({
            targetPath,
            staleMs: 30_000,
            timeoutMs: Number.POSITIVE_INFINITY,
            retry: {},
            payload: nestedPayload,
          }));
          return { owner: "outer" };
        },
      });
      expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(managerState(key).admissions.size).toBe(0);
    } finally {
      await outer?.release().catch(() => undefined);
      await first.drain();
      await second.drain();
    }
  });

  it("ignores an inactive scope when detached work starts after publication", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-detached-");
    const targetPath = path.join(directory, "state.json");
    const key = `detached:${directory}`;
    const manager = createSidecarLockManager(key);
    const startDetached = deferred();
    let detached: Promise<SidecarLockHandle> | undefined;
    const outer = await manager.acquire({
      targetPath,
      staleMs: 30_000,
      payload: async () => {
        detached = Promise.resolve().then(async () => {
          await startDetached.promise;
          return await manager.acquire({
            targetPath,
            staleMs: 30_000,
            payload: async () => ({ owner: "detached" }),
          });
        });
        return { owner: "outer" };
      },
    });
    await outer.release();
    startDetached.resolve();
    const acquired = await detached!;
    try {
      expect(await acquired.verifyStillHeld()).toBe(true);
    } finally {
      await acquired.release();
      await manager.drain();
    }
  });

  it("rejects a descendant before a matching owner's release promise and preserves errors", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-release-cycle-");
    const targetPath = path.join(directory, "state.json");
    const key = `release-cycle:${directory}`;
    const manager = createSidecarLockManager(key);
    const holder = await manager.acquire({
      targetPath,
      staleMs: 30_000,
      reentrantOwner: "holder",
      payload: async () => ({ owner: "holder" }),
    });
    const state = managerState(key);
    const held = state.held.get(holder.normalizedTargetPath)!;
    const releaseGate = deferred();
    void releaseGate.promise.catch(() => undefined);
    held.releasePromise = releaseGate.promise;
    const outerError = new Error("outer callback failed");
    let nestedError: unknown;
    try {
      const failed = manager.acquire({
        targetPath,
        staleMs: 30_000,
        reentrantOwner: "candidate",
        payload: async () => {
          nestedError = await rejection(manager.acquire({
            targetPath,
            staleMs: 30_000,
            reentrantOwner: "holder",
            timeoutMs: Number.POSITIVE_INFINITY,
            retry: {},
            payload: async () => ({ unused: true }),
          }));
          throw outerError;
        },
      });
      expect(await rejection(failed)).toBe(outerError);
      expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
      expect(state.admissions.size).toBe(0);
      expect(state.held.get(holder.normalizedTargetPath)).toBe(held);
    } finally {
      releaseGate.resolve();
      await releaseGate.promise;
      held.releasePromise = undefined;
      await holder.release().catch(() => undefined);
      await manager.drain();
    }
  });
});
