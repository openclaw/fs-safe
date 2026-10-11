import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.each(["async", "sync"] as const)("%s native empty cleanup dispatch", (variant) => {
  it.each(["empty", "populated", "legacy"] as const)("preserves the %s path", async (kind) => {
    configureFsSafeNative({ mode: "require" });
    const rootDir = await tempRoot("fs-safe-native-empty-dispatch-");
    const remove = vi.fn((_parent: number, name: string) => {
      fsSync.rmSync(path.join(rootDir, name), { recursive: true });
      return { outcome: "removed" as const };
    });
    const empty = vi.fn((_parent: number, name: string) => {
      if (kind === "populated") return { outcome: "not-empty" as const };
      fsSync.rmdirSync(path.join(rootDir, name));
      return { outcome: "removed" as const };
    });
    const asyncRemove = vi.fn(async (...args: [number, string]) => remove(...args));
    __setNativeLoaderForTest(() => ({
      closeOwnedFd: fsSync.closeSync,
      ownedTreeRemovalAvailable: () => true,
      renameNoReplace: (_from: number, name: string, _to: number, renamed: string) =>
        fsSync.renameSync(path.join(rootDir, name), path.join(rootDir, renamed)),
      removeOwnedTree: asyncRemove,
      removeOwnedTreeSync: remove,
      ...(kind === "legacy" ? {} : { tryRemoveEmptyOwnedTree: empty }),
    }) as unknown as NativeBinding);
    const options = { rootDir, prefix: "workspace-", cleanupSafety: "require-bounded" as const };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    if (kind === "populated") {
      fsSync.writeFileSync(path.join(workspace.dir, "owned"), "owned");
      // Windows may defer directory timestamp updates after child creation.
      fsSync.utimesSync(workspace.dir, 0, 1);
    }
    expect(await workspace.cleanup()).toBe("removed");
    expect(empty).toHaveBeenCalledTimes(kind === "empty" ? 1 : 0);
    expect(remove).toHaveBeenCalledTimes(kind === "empty" ? 0 : 1);
    expect(asyncRemove).toHaveBeenCalledTimes(variant === "async" && kind !== "empty" ? 1 : 0);
    expect(await workspace.cleanup()).toBe("missing");
  });
});

describe.each(["async", "sync"] as const)("%s empty workspace cleanup", (variant) => {
  async function create() {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-empty-cleanup-");
    const options = { rootDir, prefix: "workspace-" };
    return variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
  }

  it.skipIf(process.platform === "win32")("removes an empty quarantine without recursive rm", async () => {
    const workspace = await create();
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    const rmdir = vi.spyOn(fs, "rmdir");
    const rmdirSync = vi.spyOn(fsSync, "rmdirSync");
    expect(await workspace.cleanup()).toBe("removed");
    expect(await workspace.cleanup()).toBe("missing");
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect(rmdir).toHaveBeenCalledTimes(variant === "async" ? 1 : 0);
    expect(rmdirSync).toHaveBeenCalledTimes(variant === "sync" ? 1 : 0);
    expect(fsSync.existsSync(workspace.dir)).toBe(false);
  });

  it("keeps recursive cleanup for populated workspaces", async () => {
    const workspace = await create();
    fsSync.mkdirSync(path.join(workspace.dir, "nested"));
    fsSync.writeFileSync(path.join(workspace.dir, "nested", "owned"), "owned");
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await workspace.cleanup()).toBe("removed");
    expect(rm).toHaveBeenCalledTimes(variant === "async" ? 1 : 0);
    expect(rmSync).toHaveBeenCalledTimes(variant === "sync" ? 1 : 0);
    expect(fsSync.existsSync(workspace.dir)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("preserves a quarantine replaced during the failed empty removal", async () => {
    const workspace = await create();
    let quarantine = "";
    const swap = (target: fsSync.PathLike) => {
      quarantine = target.toString();
      fsSync.writeFileSync(path.join(quarantine, "owned"), "owned");
      fsSync.renameSync(quarantine, `${quarantine}.original`);
      fsSync.mkdirSync(quarantine);
      fsSync.writeFileSync(path.join(quarantine, "keep"), "replacement");
      throw Object.assign(new Error("directory is not empty"), { code: "ENOTEMPTY" });
    };
    if (variant === "async") vi.spyOn(fs, "rmdir").mockImplementationOnce(async (target) => swap(target));
    else vi.spyOn(fsSync, "rmdirSync").mockImplementationOnce(swap);
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect(fsSync.readFileSync(path.join(quarantine, "keep"), "utf8")).toBe("replacement");
    expect(fsSync.readFileSync(path.join(`${quarantine}.original`, "owned"), "utf8")).toBe("owned");
  });

  it.skipIf(process.platform === "win32")("does not treat unchanged timestamps as proof that a workspace is empty", async () => {
    const workspace = await create();
    const initial = fsSync.lstatSync(workspace.dir, { bigint: true });
    fsSync.writeFileSync(path.join(workspace.dir, "owned"), "owned");
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (args[0] === workspace.dir && args[1]?.bigint) {
        Object.assign(stat, { mtimeNs: initial.mtimeNs, ctimeNs: initial.ctimeNs });
      }
      return stat;
    });
    const rmdir = vi.spyOn(fs, "rmdir");
    const rmdirSync = vi.spyOn(fsSync, "rmdirSync");
    const recursive = vi.spyOn(fsSync, "rmSync");
    expect(await workspace.cleanup()).toBe("removed");
    expect(rmdir).toHaveBeenCalledTimes(variant === "async" ? 1 : 0);
    if (variant === "sync") {
      // Node 22 also calls the exported rmdirSync during recursive removal.
      expect(rmdirSync.mock.calls[0]?.[0]).toMatch(/\.fs-safe-workspace-cleanup-/);
      expect(recursive).toHaveBeenCalledTimes(1);
    } else {
      expect(rmdirSync).not.toHaveBeenCalled();
    }
    expect(fsSync.existsSync(workspace.dir)).toBe(false);
  });
});
