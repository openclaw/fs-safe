import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe.each(["off", "auto"] as const)("Root-backed lock normalization (%s)", (mode) => {
  it("does not create an external target parent when an explicit in-root lock is supplied", async () => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-lock-external-target-");
    const lockDirectory = path.join(directory, "locks");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const parent = path.join(directory, "external", "missing");
    const targetPath = path.join(parent, "state.json");
    const lockPath = path.join(lockDirectory, "state.lock");
    const manager = createSidecarLockManager(`external-target:${directory}`);
    const create = vi.spyOn(lockRoot, "create");
    const lock = await manager.acquire({ targetPath, lockPath, lockRoot, payload: () => ({ owner: "synthetic" }) });
    try {
      expect(lock.normalizedTargetPath).toBe(targetPath);
      expect(create).toHaveBeenCalledWith("state.lock", expect.any(String), { mkdir: true, mode: 0o600 });
      await expect(fs.lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lock.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await lock.release();
    }
    expect(await fs.readdir(directory)).toEqual(["locks"]);
    expect(await fs.readdir(lockDirectory)).toEqual([]);
  });

  it("canonicalizes missing parents below a Root alias and creates them only through Root", async () => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-lock-parent-alias-");
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const lockRoot = await root(alias);
    const targetPath = path.join(alias, "missing", "state.json");
    const canonical = path.join(actual, "missing", "state.json");
    const manager = createSidecarLockManager(`aliased-target:${directory}`);
    const create = vi.spyOn(lockRoot, "create");
    const payload = () => ({ owner: "synthetic" });
    const first = await manager.acquire({ targetPath, lockRoot, payload, reentrantOwner: "same" });
    try {
      const second = await manager.acquire({ targetPath: canonical, lockRoot, payload, reentrantOwner: "same" });
      try {
        expect(first.normalizedTargetPath).toBe(canonical);
        expect(second.normalizedTargetPath).toBe(canonical);
        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith("missing/state.json.lock", expect.any(String), { mkdir: true, mode: 0o600 });
      } finally {
        await second.release();
      }
      await expect(first.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await first.release();
    }
    expect(await fs.readdir(path.join(actual, "missing"))).toEqual([]);
  });

  itPosix("does not follow the target leaf symlink when selecting its arbitration key", async () => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-lock-leaf-alias-");
    const lockRoot = await root(directory);
    const targetPath = path.join(directory, "alias.json");
    await fs.writeFile(path.join(directory, "original.json"), "unchanged");
    await fs.symlink("original.json", targetPath);
    const manager = createSidecarLockManager(`leaf-target:${directory}`);
    const lock = await manager.acquire({ targetPath, lockRoot, payload: () => ({ owner: "synthetic" }) });
    try {
      expect(lock.normalizedTargetPath).toBe(targetPath);
      expect(lock.lockPath).toBe(`${targetPath}.lock`);
      expect(await fs.readFile(path.join(directory, "original.json"), "utf8")).toBe("unchanged");
    } finally {
      await lock.release();
    }
  });

  it("rejects a replaced Root before payload execution or reentrant held-entry reuse", async () => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-lock-stale-root-");
    const original = path.join(directory, "original");
    const moved = path.join(directory, "moved");
    await fs.mkdir(original);
    const staleRoot = await root(original);
    const before = await fs.stat(original, { bigint: true });
    // Replace before opening a sidecar: the policy must not depend on renaming an open subtree.
    await fs.rename(original, moved);
    await fs.mkdir(original);
    expect((await fs.stat(original, { bigint: true })).ino).not.toBe(before.ino);
    expect((await fs.stat(moved, { bigint: true })).ino).toBe(before.ino);
    const freshRoot = await root(original);
    const targetPath = path.join(original, "state.json");
    const manager = createSidecarLockManager(`stale-root:${directory}`);
    const payload = vi.fn(() => ({ owner: "synthetic" }));
    const options = { targetPath, payload, reentrantOwner: "same", timeoutMs: 1000, retry: { retries: 0 } };
    {
      await using first = await manager.acquire({ ...options, lockRoot: freshRoot });
      payload.mockClear();
      let refusal: unknown;
      // Retain an unexpected success too, so both handles close if the assertion fails.
      await using unexpected = await manager.acquire({ ...options, lockRoot: staleRoot }).catch((error: unknown) => {
        refusal = error;
        return undefined;
      });
      expect(refusal).toMatchObject({ code: "path-mismatch" });
      expect(unexpected).toBeUndefined();
      expect(payload).not.toHaveBeenCalled();
      await expect(first.verifyStillHeld()).resolves.toBe(true);
      expect(await fs.readdir(original)).toEqual(["state.json.lock"]);
    }
    expect(await fs.readdir(original)).toEqual([]);
    expect(await fs.readdir(moved)).toEqual([]);
  });
});
