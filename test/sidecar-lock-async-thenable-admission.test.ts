import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager, type SidecarLockHandle } from "../src/sidecar-lock.js";
import type { HeldSidecarLock } from "../src/sidecar-lock-acquire.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const managersKey = Symbol.for("fsSafe.sidecarLockManagers");
type ResultForm = "then-getter" | "async-then" | "promise-subclass";
type CallbackSite = "payload" | "shouldReclaim" | "shouldRemoveStaleLock";
type ManagerState = { admissions: Map<string, object>; held: Map<string, HeldSidecarLock> };

function managerState(key: string): ManagerState {
  return (Reflect.get(globalThis, managersKey) as Map<string, ManagerState>).get(key)!;
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

function assimilating<T>(form: ResultForm, value: T, effect: () => Promise<void>): Promise<T> {
  let started: Promise<void> | undefined;
  const start = () => started ??= effect();
  if (form === "then-getter") {
    return Object.defineProperty({}, "then", {
      get() {
        const pending = start();
        return (resolve: (result: T) => void, reject: (error: unknown) => void) => {
          void pending.then(() => resolve(value), reject);
        };
      },
    }) as unknown as Promise<T>;
  }
  if (form === "async-then") {
    return {
      then(resolve: (result: T) => void, reject: (error: unknown) => void) {
        void (async () => {
          await Promise.resolve();
          await start();
          resolve(value);
        })().catch(reject);
      },
    } as unknown as Promise<T>;
  }
  class AssimilatingPromise extends Promise<T> {
    static override get [Symbol.species](): PromiseConstructor { return Promise; }

    override then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((result: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((error: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return start().then(() => super.then(onfulfilled, onrejected));
    }
  }
  return new AssimilatingPromise<T>((resolve) => resolve(value));
}

function requiredNativeMode(): "off" | "require" {
  return process.env.FS_SAFE_NATIVE_MODE === "require" ? "require" : "off";
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
});

describe("async sidecar thenable assimilation admission", () => {
  it.each([
    ...(["payload", "shouldReclaim", "shouldRemoveStaleLock"] as const).flatMap((site) =>
      (["then-getter", "async-then", "promise-subclass"] as const).flatMap((form) =>
        (["raw", "root"] as const).map((authority) => ({ authority, form, site })))),
  ])("scopes $site $form assimilation for $authority", async ({ authority, form, site }) => {
    configureFsSafeNative({ mode: requiredNativeMode() });
    const directory = await tempRoot(`fs-safe-thenable-${site}-${form}-${authority}-`);
    const targetA = path.join(directory, "a.json");
    const targetB = path.join(directory, "b.json");
    const lockRoot = authority === "root" ? await root(directory) : undefined;
    const key = `thenable:${site}:${form}:${authority}:${directory}`;
    const manager = createSidecarLockManager(key);
    const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
    const distinctPayload = vi.fn(async () => ({ owner: "distinct" }));
    const sleeps = vi.spyOn(globalThis, "setTimeout");
    const normalizedA = path.join(await fs.realpath(directory), "a.json");
    let nestedError: unknown;
    let distinct: SidecarLockHandle | undefined;
    const effect = async () => {
      const releaseGate = deferred();
      const syntheticHeld = {
        reentrantOwner: "cycle", releasePromise: releaseGate.promise,
      } as unknown as HeldSidecarLock;
      managerState(key).held.set(normalizedA, syntheticHeld);
      try {
        const nested = manager.acquire({
          targetPath: targetA, lockRoot, staleMs: 30_000, reentrantOwner: "cycle",
          lockPath: path.join(directory, "nested.lock"),
          timeoutMs: Number.POSITIVE_INFINITY, retry: {}, payload: nestedPayload,
        });
        const other = manager.acquire({
          targetPath: targetB, lockRoot, staleMs: 30_000, payload: distinctPayload,
        });
        nestedError = await rejection(nested);
        distinct = await other;
        await distinct.release();
        distinct = undefined;
      } finally {
        if (managerState(key).held.get(normalizedA) === syntheticHeld) {
          managerState(key).held.delete(normalizedA);
        }
        releaseGate.resolve();
      }
    };
    const lockPath = `${targetA}.lock`;
    if (site !== "payload") await fs.writeFile(lockPath, JSON.stringify({ owner: "external" }));
    let outer: SidecarLockHandle | undefined;
    try {
      const acquiring = manager.acquire({
        targetPath: targetA, lockRoot, staleMs: site === "payload" ? 30_000 : 0,
        timeoutMs: 0, retry: { retries: 0 },
        payload: site === "payload"
          ? () => assimilating(form, { owner: "outer" }, effect)
          : async () => ({ owner: "candidate" }),
        ...(site === "shouldReclaim" ? {
          shouldReclaim: () => assimilating(form, false, effect),
        } : site === "shouldRemoveStaleLock" ? {
          shouldReclaim: async () => true,
          staleRecovery: "remove-if-unchanged" as const,
          shouldRemoveStaleLock: () => assimilating(form, false, effect),
        } : {}),
      });
      if (site === "payload") outer = await acquiring;
      else expect(await rejection(acquiring)).toMatchObject({
        code: site === "shouldReclaim" ? "file_lock_timeout" : "file_lock_stale",
      });
      expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(distinctPayload).toHaveBeenCalledOnce();
      expect(sleeps).not.toHaveBeenCalled();
      expect(managerState(key).admissions.size).toBe(0);
    } finally {
      await distinct?.release().catch(() => undefined);
      await outer?.release().catch(() => undefined);
      await manager.drain();
      await fs.rm(lockPath, { force: true });
    }
  });

  it.each(
    (["payload", "shouldReclaim", "shouldRemoveStaleLock"] as const).flatMap((site) =>
      (["raw", "root"] as const).flatMap((authority) =>
        (["error", "undefined"] as const).map((failureKind) => ({ authority, failureKind, site })))),
  )("preserves throwing $failureKind $site then-getter identity and cleanup for $authority",
    async ({ authority, failureKind, site }) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-then-getter-throw-${site}-${authority}-`);
      const target = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const lockPath = `${target}.lock`;
      const original = JSON.stringify({ owner: "external" });
      if (site !== "payload") await fs.writeFile(lockPath, original);
      const key = `then-getter-throw:${site}:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const failure = failureKind === "error" ? new Error("then getter failed") : undefined;
      const throwing = () => Object.defineProperty({}, "then", {
        get() { throw failure; },
      }) as unknown as Promise<boolean>;
      const rejected = manager.acquire({
        targetPath: target, lockRoot, staleMs: site === "payload" ? 30_000 : 0,
        payload: site === "payload"
          ? throwing as unknown as () => Promise<Record<string, unknown>>
          : async () => ({ owner: "candidate" }),
        ...(site === "shouldReclaim" ? { shouldReclaim: throwing } : {}),
        ...(site === "shouldRemoveStaleLock" ? {
          shouldReclaim: async () => true,
          staleRecovery: "remove-if-unchanged" as const,
          shouldRemoveStaleLock: throwing,
        } : {}),
      });
      expect(await rejection(rejected)).toBe(failure);
      expect(managerState(key).admissions.size).toBe(0);
      await expect(fs.access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
      if (site !== "payload") expect(await fs.readFile(lockPath, "utf8")).toBe(original);
      await fs.rm(lockPath, { force: true });
      const probe = await manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
        payload: async () => ({ owner: "probe" }),
      });
      await probe.release();
      await manager.drain();
    },
  );

  it.each(["raw", "root"] as const)(
    "preserves rejected payload identity, holder ownership, and fresh recovery for $authority",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-thenable-reject-${authority}-`);
      const target = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `thenable-reject:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const holder = await manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "holder" }),
      });
      const failure = new Error("payload rejected");
      try {
        const failed = manager.acquire({
          targetPath: target, lockRoot, staleMs: 30_000,
          payload: () => Promise.reject(failure),
        });
        expect(await rejection(failed)).toBe(failure);
        expect(managerState(key).admissions.size).toBe(0);
        expect(await holder.verifyStillHeld()).toBe(true);
      } finally {
        await holder.release();
      }
      const probe = await manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
        payload: async () => ({ owner: "probe" }),
      });
      await probe.release();
      await manager.drain();
    },
  );

  it.each(
    (["shouldReclaim", "shouldRemoveStaleLock"] as const).flatMap((site) =>
      (["raw", "root"] as const).map((authority) => ({ authority, site }))),
  )("preserves rejected $site identity and reclaim cleanup for $authority",
    async ({ authority, site }) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-thenable-reject-${site}-${authority}-`);
      const target = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const lockPath = `${target}.lock`;
      const original = JSON.stringify({ owner: "external" });
      await fs.writeFile(lockPath, original);
      const key = `thenable-reject:${site}:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const failure = new Error(`${site} rejected`);
      const failed = manager.acquire({
        targetPath: target, lockRoot, staleMs: 0,
        payload: async () => ({ owner: "candidate" }),
        shouldReclaim: site === "shouldReclaim"
          ? () => Promise.reject(failure) : async () => true,
        ...(site === "shouldRemoveStaleLock" ? {
          staleRecovery: "remove-if-unchanged" as const,
          shouldRemoveStaleLock: () => Promise.reject(failure),
        } : {}),
      });
      expect(await rejection(failed)).toBe(failure);
      expect(managerState(key).admissions.size).toBe(0);
      await expect(fs.access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(lockPath, "utf8")).toBe(original);
      await fs.rm(lockPath);
      const probe = await manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000,
        payload: async () => ({ owner: "probe" }),
      });
      await probe.release();
      await manager.drain();
    },
  );

  it("rejects a thenable descendant before awaiting a matching release", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-thenable-release-cycle-");
    const target = path.join(directory, "state.json");
    const key = `thenable-release:${directory}`;
    const manager = createSidecarLockManager(key);
    const holder = await manager.acquire({
      targetPath: target, staleMs: 30_000, reentrantOwner: "holder",
      payload: async () => ({ owner: "holder" }),
    });
    const held = managerState(key).held.get(holder.normalizedTargetPath)!;
    const releaseGate = deferred();
    held.releasePromise = releaseGate.promise;
    const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
    const sleeps = vi.spyOn(globalThis, "setTimeout");
    let nestedError: unknown;
    try {
      const outer = manager.acquire({
        targetPath: target, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
        payload: () => assimilating("async-then", { owner: "outer" }, async () => {
          nestedError = await rejection(manager.acquire({
            targetPath: target, staleMs: 30_000, reentrantOwner: "holder",
            timeoutMs: Number.POSITIVE_INFINITY, retry: {}, payload: nestedPayload,
          }));
          held.releasePromise = undefined;
        }),
      });
      expect(await rejection(outer)).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(sleeps).not.toHaveBeenCalled();
    } finally {
      held.releasePromise = undefined;
      releaseGate.resolve();
      await holder.release().catch(() => undefined);
      await manager.drain();
    }
  });

  it("shares payload assimilation ancestry across reloaded package graphs", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-thenable-cross-copy-");
    const target = path.join(directory, "state.json");
    const key = `thenable-cross-copy:${directory}`;
    const first = createSidecarLockManager(key);
    vi.resetModules();
    const second = (await import("../src/sidecar-lock.js")).createSidecarLockManager(key);
    const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
    let nestedError: unknown;
    const outer = await first.acquire({
      targetPath: target, staleMs: 30_000,
      payload: () => assimilating("then-getter", { owner: "outer" }, async () => {
        nestedError = await rejection(second.acquire({
          targetPath: target, staleMs: 30_000, timeoutMs: Number.POSITIVE_INFINITY,
          retry: {}, payload: nestedPayload,
        }));
      }),
    });
    try {
      expect(nestedError).toMatchObject({ code: "file_lock_timeout" });
      expect(nestedPayload).not.toHaveBeenCalled();
    } finally {
      await outer.release();
      await first.drain();
      await second.drain();
    }
  });

  it("preserves A-to-B-to-A ancestry through Promise-subclass assimilation", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-thenable-aba-");
    const targetA = path.join(directory, "a.json");
    const targetB = path.join(directory, "b.json");
    const manager = createSidecarLockManager(`thenable-aba:${directory}`);
    const innerPayload = vi.fn(async () => ({ owner: "inner-a" }));
    let innerError: unknown;
    const outer = await manager.acquire({
      targetPath: targetA, staleMs: 30_000,
      payload: () => assimilating("promise-subclass", { owner: "outer-a" }, async () => {
        const middle = await manager.acquire({
          targetPath: targetB, staleMs: 30_000,
          payload: () => assimilating("async-then", { owner: "middle-b" }, async () => {
            innerError = await rejection(manager.acquire({
              targetPath: targetA, staleMs: 30_000, timeoutMs: Number.POSITIVE_INFINITY,
              retry: {}, payload: innerPayload,
            }));
          }),
        });
        await middle.release();
      }),
    });
    try {
      expect(innerError).toMatchObject({ code: "file_lock_timeout" });
      expect(innerPayload).not.toHaveBeenCalled();
    } finally {
      await outer.release();
      await manager.drain();
    }
  });

  it.each(["raw", "root"] as const)(
    "boxes a repeated-getter payload before leaving $authority admission scope",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-thenable-box-${authority}-`);
      const target = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `thenable-box:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
      let getterCalls = 0;
      let nested: Promise<unknown> | undefined;
      const payload = Object.defineProperty({ owner: "outer" }, "then", {
        get() {
          getterCalls += 1;
          if (getterCalls === 1) {
            nested = rejection(manager.acquire({
              targetPath: target, lockRoot, staleMs: 30_000,
              timeoutMs: Number.POSITIVE_INFINITY, retry: {}, payload: nestedPayload,
            }));
          } else {
            managerState(key).admissions.clear();
          }
          return undefined;
        },
      });
      const outer = await manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000,
        payload: () => payload,
      });
      try {
        expect(getterCalls).toBe(1);
        expect(await nested).toMatchObject({ code: "file_lock_timeout" });
        expect(nestedPayload).not.toHaveBeenCalled();
        expect(managerState(key).admissions.size).toBe(0);
        expect(await outer.verifyStillHeld()).toBe(true);
      } finally {
        await outer.release();
        await manager.drain();
      }
    },
  );

  it.each(["raw", "root"] as const)(
    "fails closed when a $authority payload then-getter loses its admission token",
    async (authority) => {
      configureFsSafeNative({ mode: requiredNativeMode() });
      const directory = await tempRoot(`fs-safe-thenable-token-${authority}-`);
      const target = path.join(directory, "state.json");
      const lockRoot = authority === "root" ? await root(directory) : undefined;
      const key = `thenable-token:${authority}:${directory}`;
      const manager = createSidecarLockManager(key);
      let getterCalls = 0;
      const payload = Object.defineProperty({ owner: "lost" }, "then", {
        get() {
          getterCalls += 1;
          managerState(key).admissions.clear();
          return undefined;
        },
      });
      const failed = manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000,
        timeoutMs: 0, retry: { retries: 0 }, payload: () => payload,
      });
      expect(await rejection(failed)).toMatchObject({ code: "file_lock_timeout" });
      expect(getterCalls).toBe(1);
      expect(managerState(key).admissions.size).toBe(0);
      await expect(fs.access(`${target}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      const probe = await manager.acquire({
        targetPath: target, lockRoot, staleMs: 30_000,
        timeoutMs: 0, retry: { retries: 0 }, payload: async () => ({ owner: "probe" }),
      });
      await probe.release();
      await manager.drain();
    },
  );
});
