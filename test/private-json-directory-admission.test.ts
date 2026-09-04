import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as privateBoundary from "../src/file-store-boundary.js";
import { createJsonStore } from "../src/json-document-store.js";
import { root } from "../src/root.js";
import { fileStore, jsonStore } from "../src/store.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("private JSON directory admission before locking", () => {
  it.each(["write", "update", "updateOr"] as const)("prepares missing private directories before locked %s", async (operation) => {
    const sandbox = await tempRoot("fs-safe-private-json-prepare-");
    const rootDir = path.join(sandbox, "root");
    const state = fileStore({ rootDir, private: true }).json<{ count: number }>("café/state.json", { lock: true });
    if (operation === "write") await state.write({ count: 1 });
    else if (operation === "update") await state.update(() => ({ count: 1 }));
    else await state.updateOr({ count: 0 }, (current) => ({ count: current.count + 1 }));

    expect(await state.readRequired()).toEqual({ count: 1 });
    expect(await fs.readdir(path.join(rootDir, "café"))).toEqual(["state.json"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(rootDir)).mode & 0o7777).toBe(0o700);
      expect((await fs.stat(path.join(rootDir, "café"))).mode & 0o7777).toBe(0o700);
    }
  });

  it("prepares the standalone jsonStore's missing root without implicit repair", async () => {
    const sandbox = await tempRoot("fs-safe-json-store-prepare-");
    const filePath = path.join(sandbox, "nested", "state.json");
    const state = jsonStore<{ count: number }>({ filePath, lock: true });
    await state.updateOr({ count: 0 }, (current) => ({ count: current.count + 1 }));
    expect(await state.readRequired()).toEqual({ count: 1 });
    if (process.platform !== "win32") expect((await fs.stat(path.dirname(filePath))).mode & 0o7777).toBe(0o700);
  });

  itPosix("rejects an existing non-private parent before acquiring a lock or running the update", async () => {
    const rootDir = await tempRoot("fs-safe-private-json-refuse-");
    const parent = path.join(rootDir, "parent");
    await fs.mkdir(parent, { mode: 0o750 });
    await fs.chmod(parent, 0o750);
    const state = fileStore({ rootDir, private: true }).json("parent/state.json", { lock: true });
    const update = vi.fn(() => ({ count: 1 }));
    const mkdir = vi.spyOn(fs, "mkdir");
    const chmod = vi.spyOn(fs, "chmod");

    await expect(state.update(update)).rejects.toMatchObject({ code: "insecure-permissions" });

    expect(update).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect((await fs.stat(parent)).mode & 0o7777).toBe(0o750);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("keeps the admitted parent identity when lock normalization sees a replacement", async () => {
    const rootDir = await tempRoot("fs-safe-private-json-parent-swap-");
    const parent = path.join(rootDir, "parent");
    const moved = path.join(rootDir, "moved");
    const state = fileStore({ rootDir, private: true }).json("parent/state.json", { lock: true });
    const prepare = privateBoundary.openPrivateStoreLockRoot;
    let swapped = false;
    const prepareSpy = vi.spyOn(privateBoundary, "openPrivateStoreLockRoot").mockImplementation(async (params) => {
      const admitted = await prepare(params);
      await fs.rename(parent, moved);
      await fs.mkdir(parent, { mode: 0o700 });
      swapped = true;
      return admitted;
    });
    const update = vi.fn(() => ({ count: 1 }));

    await expect(state.update(update)).rejects.toMatchObject({ code: "path-mismatch" });

    expect(swapped).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readdir(moved)).toEqual([]);
    prepareSpy.mockRestore();
    await state.write({ count: 2 });
    expect(await state.readRequired()).toEqual({ count: 2 });
  });

  it("does not recreate an admitted parent deleted before lock acquisition", async () => {
    const rootDir = await tempRoot("fs-safe-private-json-parent-deleted-");
    const parent = path.join(rootDir, "parent");
    const state = fileStore({ rootDir, private: true }).json("parent/state.json", { lock: true });
    const prepare = privateBoundary.openPrivateStoreLockRoot;
    let removed = false;
    vi.spyOn(privateBoundary, "openPrivateStoreLockRoot").mockImplementation(async (params) => {
      const admitted = await prepare(params);
      await fs.rmdir(parent);
      removed = true;
      return admitted;
    });
    const update = vi.fn(() => ({ count: 1 }));

    await expect(state.update(update)).rejects.toMatchObject({ code: "path-mismatch" });

    expect(removed).toBe(true);
    expect(update).not.toHaveBeenCalled();
    await expect(fs.lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("does not prepare directories on reads", async () => {
    const sandbox = await tempRoot("fs-safe-private-json-read-");
    const state = fileStore({ rootDir: path.join(sandbox, "missing"), private: true })
      .json("parent/state.json", { lock: true });
    await expect(state.read()).resolves.toBeUndefined();
    await expect(state.readOr({ count: 0 })).resolves.toEqual({ count: 0 });
    expect(await fs.readdir(sandbox)).toEqual([]);
  });

  it("does not invoke adapter preparation when locking is disabled", async () => {
    const directory = await tempRoot("fs-safe-json-unlocked-prepare-");
    const prepareLock = vi.fn(async () => await root(directory));
    const write = vi.fn(async () => undefined);
    const state = createJsonStore({
      filePath: path.join(directory, "state.json"),
      prepareLock,
      readIfExists: async () => undefined,
      readRequired: async () => ({}),
      write,
    }, { lock: false });
    await state.write({});
    expect(prepareLock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
  });
});
