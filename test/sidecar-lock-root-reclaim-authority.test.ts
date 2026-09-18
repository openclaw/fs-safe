import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { acquireFileLockSync } from "../src/file-lock.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it("retains Root mutation authority after an awaited stale-removal decision", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-root-stale-authority-");
  const rejection = new Error("Root authority revoked");
  let allowed = true;
  const assertion = vi.fn(() => { if (!allowed) throw rejection; });
  const lockRoot = await root(directory, { assertBeforeMutation: assertion });
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  const original = JSON.stringify({ owner: "stale" });
  await fs.writeFile(lockPath, original);
  const manager = createSidecarLockManager(directory);
  const shouldRemoveStaleLock = vi.fn(async () => {
    await Promise.resolve();
    allowed = false;
    return true;
  });
  await expect(manager.acquire({
    targetPath, lockPath, lockRoot, staleMs: 0, timeoutMs: 0,
    payload: async () => ({ owner: "new" }),
    shouldReclaim: () => true,
    staleRecovery: "remove-if-unchanged",
    shouldRemoveStaleLock,
  })).rejects.toBe(rejection);
  expect(assertion).toHaveBeenCalled();
  expect(shouldRemoveStaleLock).toHaveBeenCalledOnce();
  expect(await fs.readFile(lockPath, "utf8")).toBe(original);
  expect((await fs.stat(`${lockPath}.reclaim`)).isFile()).toBe(true);
  expect(manager.heldEntries()).toEqual([]);
});

it.each(["policy", "parser"] as const)("preserves a replacement guard after the %s callback", async site => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-root-guard-swap-");
  const lockRoot = await root(directory);
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  const guardPath = `${lockPath}.reclaim`;
  const original = JSON.stringify({ owner: "stale" });
  await fs.writeFile(lockPath, original);
  let approved = false;
  let swapped = false;
  const replaceGuard = () => {
    fsSync.renameSync(guardPath, `${guardPath}.saved`);
    fsSync.writeFileSync(guardPath, "replacement", { flag: "wx" });
    swapped = true;
  };
  const manager = createSidecarLockManager(directory);
  await expect(manager.acquire({
    targetPath, lockPath, lockRoot, staleMs: 0, timeoutMs: 0,
    payload: async () => ({ owner: "new" }),
    shouldReclaim: () => true, staleRecovery: "remove-if-unchanged",
    parsePayload(raw) {
      if (site === "parser" && approved && !swapped) replaceGuard();
      return JSON.parse(raw);
    },
    shouldRemoveStaleLock: async () => {
      await Promise.resolve();
      if (site === "policy") replaceGuard();
      approved = true;
      return true;
    },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(swapped).toBe(true);
  expect(await fs.readFile(guardPath, "utf8")).toBe("replacement");
  expect(await fs.readFile(lockPath, "utf8")).toBe(original);
});

it("excludes raw and Root synchronous contenders while a Root file guard is held", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-root-guard-contention-");
  const lockRoot = await root(directory);
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ owner: "stale" }));
  const manager = createSidecarLockManager(directory);
  const held = await manager.acquire({
    targetPath, lockPath, lockRoot, staleMs: 0, timeoutMs: 0,
    payload: async () => ({ owner: "new" }),
    shouldReclaim: () => true, staleRecovery: "remove-if-unchanged",
    shouldRemoveStaleLock: () => {
      expect(fsSync.statSync(`${lockPath}.reclaim`).isFile()).toBe(true);
      for (const contenderRoot of [undefined, lockRoot]) {
        expect(() => acquireFileLockSync(path.join(directory, "other"), {
          lockPath, lockRoot: contenderRoot, timeoutMs: 0, retry: { retries: 0 },
          payload: () => ({ owner: "contender" }),
        })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      }
      return true;
    },
  });
  await held.release();
  await expect(fs.lstat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps same-target cleanup callbacks inside the failed attempt's admission", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-root-guard-cleanup-context-");
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  const manager = createSidecarLockManager(directory);
  const nested: Promise<unknown>[] = [];
  const nestedPayload = vi.fn(async () => ({ owner: "nested" }));
  let cleaning = false;
  const lockRoot = await root(directory, { assertBeforeMutation() {
    if (!cleaning) return;
    nested.push(manager.acquire({
      targetPath, lockPath, lockRoot, payload: nestedPayload, staleMs: 0,
      timeoutMs: 1000, retry: { retries: 100, minTimeout: 1, maxTimeout: 1 },
      shouldReclaim: () => false,
    }).then(async held => { await held.release(); return "unexpected acquisition"; }, error => error));
  } });
  await fs.writeFile(lockPath, JSON.stringify({ owner: "stale" }));
  const failure = new Error("stale approval failed");
  await expect(manager.acquire({
    targetPath, lockPath, lockRoot, staleMs: 0, timeoutMs: 0,
    payload: async () => ({ owner: "new" }),
    shouldReclaim: () => true, staleRecovery: "remove-if-unchanged",
    shouldRemoveStaleLock() { cleaning = true; throw failure; },
  })).rejects.toBe(failure);
  expect(nested.length).toBeGreaterThan(0);
  for (const outcome of await Promise.all(nested)) {
    expect(outcome).toMatchObject({ code: "file_lock_timeout" });
  }
  expect(nestedPayload).not.toHaveBeenCalled();
  await expect(fs.lstat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("applies Root deny policy to the reclaim guard itself", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-root-denied-guard-");
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  const guardPath = `${lockPath}.reclaim`;
  const lockRoot = await root(directory, { denyMutations: { paths: [guardPath] } });
  const original = JSON.stringify({ owner: "stale" });
  await fs.writeFile(lockPath, original);
  const manager = createSidecarLockManager(directory);
  const outcome = await manager.acquire({
    targetPath, lockPath, lockRoot, staleMs: 0, timeoutMs: 0,
    payload: async () => ({ owner: "new" }),
    shouldReclaim: () => true, staleRecovery: "remove-if-unchanged",
    shouldRemoveStaleLock: () => true,
  }).then(held => ({ held }), (error: unknown) => ({ error }));
  try {
    expect(outcome).toMatchObject({ error: { code: "denied-path" } });
    expect(await fs.readFile(lockPath, "utf8")).toBe(original);
    await expect(fs.lstat(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if ("held" in outcome) await outcome.held.release();
  }
});

it("preserves an outside guard when the Root is replaced before cleanup", async () => {
  configureFsSafeNative({ mode: "off" });
  const base = await tempRoot("fs-safe-root-guard-parent-swap-");
  const directory = path.join(base, "root");
  const moved = path.join(base, "moved");
  const outside = path.join(base, "outside");
  await fs.mkdir(directory);
  await fs.mkdir(outside);
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  const guardName = "state.lock.reclaim";
  const outsideGuard = path.join(outside, guardName);
  await fs.mkdir(outsideGuard);
  const outsideIdentity = await fs.lstat(outsideGuard, { bigint: true });
  const lockRoot = await root(directory);
  await fs.writeFile(lockPath, JSON.stringify({ owner: "stale" }));
  const manager = createSidecarLockManager(directory);
  let swapped = false;
  try {
    await expect(manager.acquire({
      targetPath, lockPath, lockRoot, staleMs: 0, timeoutMs: 0,
      payload: async () => ({ owner: "new" }),
      shouldReclaim: () => true, staleRecovery: "remove-if-unchanged",
      shouldRemoveStaleLock: async () => {
        await fs.rename(directory, moved);
        await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
        swapped = true;
        return true;
      },
    })).rejects.toBeDefined();
    expect(swapped).toBe(true);
    const current = await fs.lstat(outsideGuard, { bigint: true });
    expect([current.dev, current.ino]).toEqual([outsideIdentity.dev, outsideIdentity.ino]);
    expect(await fs.readFile(path.join(moved, "state.lock"), "utf8"))
      .toBe(JSON.stringify({ owner: "stale" }));
  } finally {
    if (swapped) {
      await fs.unlink(directory);
      await fs.rename(moved, directory);
    }
  }
});
