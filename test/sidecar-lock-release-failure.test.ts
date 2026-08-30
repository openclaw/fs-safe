import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("asynchronous sidecar lock release failures", () => {
  it("rejects when raw sidecar deletion fails", async () => {
    const directory = await tempRoot("fs-safe-lock-release-raw-");
    const targetPath = path.join(directory, "state.json");
    const manager = createSidecarLockManager(`release-raw-${Date.now()}-${Math.random()}`);
    const lock = await manager.acquire({ targetPath, payload: async () => ({}) });
    const failure = Object.assign(new Error("release deletion failed"), { code: "EIO" });
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(lock.lockPath)) throw failure;
      return await realRm(target, ...args);
    });

    await expect(lock.release()).rejects.toBe(failure);
    await expect(fs.access(lock.lockPath)).resolves.toBeUndefined();
    expect(manager.heldEntries()).toEqual([]);

    rm.mockRestore();
    await fs.rm(lock.lockPath, { force: true });
  });

  it("rejects when Root-backed sidecar deletion fails", async () => {
    const directory = await tempRoot("fs-safe-lock-release-root-");
    const targetPath = path.join(directory, "state.json");
    const capability = await root(directory);
    const manager = createSidecarLockManager(`release-root-${Date.now()}-${Math.random()}`);
    const lock = await manager.acquire({
      targetPath,
      lockRoot: capability,
      payload: async () => ({}),
    });
    const failure = Object.assign(new Error("root release failed"), { code: "EIO" });
    const remove = vi.spyOn(capability, "remove").mockRejectedValueOnce(failure);

    await expect(lock.release()).rejects.toBe(failure);
    await expect(fs.access(lock.lockPath)).resolves.toBeUndefined();
    expect(manager.heldEntries()).toEqual([]);

    remove.mockRestore();
    await fs.rm(lock.lockPath, { force: true });
  });

  it("preserves callback and release failures from withFileLock", async () => {
    const directory = await tempRoot("fs-safe-lock-release-combined-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const bodyError = new Error("protected work failed");
    const releaseError = Object.assign(new Error("release cleanup failed"), { code: "EIO" });
    const realRm = fs.rm.bind(fs);
    let rm: ReturnType<typeof vi.spyOn> | undefined;

    const error = await withFileLock(
      targetPath,
      { managerKey: `release-combined-${Date.now()}-${Math.random()}`, payload: async () => ({}) },
      async () => {
        rm = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
          if (path.basename(String(target)) === path.basename(lockPath)) throw releaseError;
          return await realRm(target, ...args);
        });
        throw bodyError;
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "SuppressedError",
      error: releaseError,
      suppressed: bodyError,
    });
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    rm?.mockRestore();
    await fs.rm(lockPath, { force: true });
  });
});
