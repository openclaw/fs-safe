import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("sidecar admission across authority routes", () => {
  it.each(["root", "raw"] as const)("blocks a foreign route while %s holds the target", async first => {
    const directory = await tempRoot("fs-safe-mixed-held-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "target");
    for (const owner of [undefined, "same", "different"]) {
      const firstPath = path.join(directory, "first.lock");
      const nextPath = path.join(directory, "next.lock");
      const held = acquireFileLockSync(target, {
        lockRoot: first === "root" ? lockRoot : undefined,
        lockPath: firstPath, reentrantOwner: "same", payload: () => ({ owner: "first" }),
      });
      const options = {
        lockRoot: first === "raw" ? lockRoot : undefined,
        lockPath: nextPath, reentrantOwner: owner,
        timeoutMs: 0, retry: { retries: 0 }, payload: () => ({ owner: "next" }),
      };
      try {
        const raw = fsSync.readFileSync(firstPath, "utf8");
        expect(() => acquireFileLockSync(target, options)).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
        expect(fsSync.existsSync(nextPath)).toBe(false);
        expect(held.verifyStillHeld()).toBe(true);
        expect(fsSync.readFileSync(firstPath, "utf8")).toBe(raw);
      } finally { held.release(); }
      const next = acquireFileLockSync(target, options);
      expect(next.verifyStillHeld()).toBe(true);
      next.release();
    }
  });

  it.each(["root", "raw"] as const)("rejects nested opposite-route acquisition during %s payload", async first => {
    const directory = await tempRoot("fs-safe-mixed-pending-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "target");
    let nestedPayloadCalls = 0;
    const callback = () => {
      expect(() => acquireFileLockSync(target, {
        lockRoot: first === "raw" ? lockRoot : undefined,
        lockPath: path.join(directory, "nested.lock"),
        payload: () => { nestedPayloadCalls++; return {}; },
      })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      return { owner: "outer" };
    };
    Object.defineProperty(callback, "call", { get() { throw new Error("shadowed call"); } });
    const held = acquireFileLockSync(target, {
      lockRoot: first === "root" ? lockRoot : undefined,
      lockPath: path.join(directory, "outer.lock"), payload: callback,
    });
    try {
      expect(nestedPayloadCalls).toBe(0);
      expect(held.verifyStillHeld()).toBe(true);
      expect(fsSync.existsSync(path.join(directory, "nested.lock"))).toBe(false);
    } finally { held.release(); }
  });

  it("retains the Root guard until a reset-interrupted removal settles", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-root-reclaim-reset-");
    const lockRoot = await root(directory);
    const targetPath = path.join(directory, "target");
    const lockPath = path.join(directory, "target.lock");
    const manager = createSidecarLockManager(`reclaim-reset:${directory}`);
    const options = {
      targetPath, lockPath, lockRoot, staleMs: 0,
      timeoutMs: 1000, retry: { retries: 3, minTimeout: 0, maxTimeout: 0 },
      staleRecovery: "remove-if-unchanged" as const,
      shouldReclaim: () => true, shouldRemoveStaleLock: () => true,
      payload: async () => ({ owner: "new" }),
    };
    await fs.writeFile(lockPath, JSON.stringify({ owner: "stale" }));
    const entered = deferred(), resume = deferred();
    __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async (operation, candidate) => {
      if (operation !== "remove" || candidate !== lockPath) return;
      __setFsSafeTestHooksForTest();
      entered.resolve();
      await resume.promise;
    } });
    const acquiring = manager.acquire(options).then(
      handle => ({ handle }), error => ({ error }),
    );
    let successor: Awaited<ReturnType<typeof manager.acquire>> | undefined;
    try {
      await entered.promise;
      manager.reset();
      await expect(manager.acquire({ ...options, timeoutMs: 0, retry: { retries: 0 } }))
        .rejects.toMatchObject({ code: "file_lock_timeout" });
      expect((await fs.stat(`${lockPath}.reclaim`)).isFile()).toBe(true);
      expect(await fs.readFile(lockPath, "utf8")).toBe(JSON.stringify({ owner: "stale" }));
      resume.resolve();
      const result = await acquiring;
      if ("handle" in result) await result.handle.release();
      expect(result).toMatchObject({ error: { code: "file_lock_timeout" } });
      await expect(fs.lstat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
      successor = await manager.acquire(options);
      expect(await successor.verifyStillHeld()).toBe(true);
      expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ owner: "new" });
    } finally {
      resume.resolve();
      __setFsSafeTestHooksForTest();
      await acquiring;
      await successor?.release();
      await manager.drain();
    }
  });
});
