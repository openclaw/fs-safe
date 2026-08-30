import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempWorkspace, tempWorkspaceSync, withTempWorkspace, withTempWorkspaceSync } from "../src/temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});
type Cleanup = "manual" | "dispose" | "exit";

describe.each(["async", "sync"] as const)("%s temp workspace fallback cleanup", (variant) => {
  async function setup(noDescriptor = false) {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-fallback-");
    if (noDescriptor) {
      const open = fsSync.openSync;
      vi.spyOn(fsSync, "openSync").mockImplementation((name, ...args) => {
        if (name === rootDir) throw Object.assign(new Error("directory descriptor unavailable"), { code: "EISDIR" });
        return open(name, ...args);
      });
    }
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
    return { rootDir, workspace };
  }

  it.each(["off", "auto"] as const)("removes normally without a retained directory descriptor in %s mode", async (mode) => {
    const { rootDir, workspace } = await setup(true);
    configureFsSafeNative({ mode });
    expect(await workspace.cleanup()).toBe("removed");
    expect(await workspace.cleanup()).toBe("missing");
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  describe.each([false, true])("without descriptor: %s", (noDescriptor) => {
    it.each(["directory", "file", "symlink"] as const)("preserves a single raced %s replacement under quarantine", async (kind) => {
      const { rootDir, workspace } = await setup(noDescriptor);
      const outside = await tempRoot("fs-safe-temp-fallback-outside-");
      await fs.writeFile(path.join(outside, "keep.txt"), "outside");
      const rename = fsSync.renameSync;
      let quarantine = "";
      let replacement: fsSync.BigIntStats | undefined;
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        if (from === workspace.dir) {
          rename(workspace.dir, `${workspace.dir}.original`);
          if (kind === "directory") {
            fsSync.mkdirSync(workspace.dir);
            fsSync.writeFileSync(path.join(workspace.dir, "keep.txt"), "replacement");
          } else if (kind === "file") {
            fsSync.writeFileSync(workspace.dir, "replacement");
          } else {
            fsSync.symlinkSync(outside, workspace.dir, process.platform === "win32" ? "junction" : "dir");
          }
          replacement = fsSync.lstatSync(workspace.dir, { bigint: true });
          quarantine = String(to);
        }
        rename(from, to);
      });
      // Call-through observers: no identity or removal result is fabricated.
      const rm = vi.spyOn(fs, "rm");
      const rmSync = vi.spyOn(fsSync, "rmSync");
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(path.dirname(quarantine)).toBe(rootDir);
      expect(path.basename(quarantine)).toMatch(/^\.fs-safe-workspace-cleanup-[\da-f-]+$/);
      expect(await fs.lstat(quarantine, { bigint: true })).toMatchObject({ dev: replacement!.dev, ino: replacement!.ino });
      expect(await fs.readFile(kind === "file" ? quarantine : path.join(quarantine, "keep.txt"), "utf8"))
        .toBe(kind === "symlink" ? "outside" : "replacement");
      expect(await fs.readFile(path.join(`${workspace.dir}.original`, "owned.txt"), "utf8")).toBe("owned");
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside");
      await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(rm).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
    });

    it("preserves a newer public entry when the raced replacement is quarantined", async () => {
      const { workspace } = await setup(noDescriptor);
      const rename = fsSync.renameSync;
      let quarantine = "";
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        if (from === workspace.dir) {
          rename(workspace.dir, `${workspace.dir}.original`);
          fsSync.writeFileSync(workspace.dir, "replacement");
          quarantine = String(to);
        }
        rename(from, to);
        if (from === workspace.dir) fsSync.writeFileSync(workspace.dir, "newer");
      });
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(await fs.readFile(quarantine, "utf8")).toBe("replacement");
      expect(await fs.readFile(workspace.dir, "utf8")).toBe("newer");
    });

    it.each(["before-rename", "after-rename"])("preserves entries if the parent moves %s", async (when) => {
      const { rootDir, workspace } = await setup(noDescriptor);
      const moved = path.join(await tempRoot("fs-safe-temp-fallback-moved-"), "parent");
      const rename = fsSync.renameSync;
      let quarantine = "";
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        if (from !== workspace.dir) return rename(from, to);
        quarantine = String(to);
        const move = () => {
          rename(rootDir, moved);
          fsSync.mkdirSync(rootDir);
          fsSync.mkdirSync(workspace.dir);
          fsSync.writeFileSync(path.join(workspace.dir, "keep.txt"), "replacement");
        };
        if (when === "before-rename") move();
        rename(from, to);
        if (when === "after-rename") move();
      });
      expect(await workspace.cleanup()).toBe("indeterminate");
      const owned = path.join(moved, path.basename(when === "before-rename" ? workspace.dir : quarantine));
      expect(await fs.readFile(path.join(owned, "owned.txt"), "utf8")).toBe("owned");
      expect(await fs.readFile(path.join(when === "before-rename" ? quarantine : workspace.dir, "keep.txt"), "utf8"))
        .toBe("replacement");
    });
  });

  it.each(["before-rename", "after-rename"])("preserves remaining entries on an ambiguous error %s", async (when) => {
    const { workspace } = await setup();
    const rename = fsSync.renameSync;
    let quarantine = "";
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (from !== workspace.dir) return rename(from, to);
      quarantine = String(to);
      if (when === "after-rename") rename(from, to);
      throw Object.assign(new Error("rename outcome unknown"), { code: "EIO" });
    });
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(when === "before-rename" ? workspace.dir : quarantine, "owned.txt"), "utf8"))
      .toBe("owned");
  });

  it("serializes cleanup and recursively removes only quarantine while preserving a new public entry", async () => {
    const { workspace } = await setup();
    const rename = fsSync.renameSync;
    let quarantine = "";
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (from === workspace.dir) {
        quarantine = String(to);
        fsSync.writeFileSync(workspace.dir, "newer");
      }
    });
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await Promise.all([workspace.cleanup(), workspace.cleanup(), workspace.cleanup()]))
      .toEqual(["removed", "missing", "missing"]);
    const calls = [...rm.mock.calls, ...rmSync.mock.calls];
    expect(calls).toEqual([[quarantine, { recursive: true, force: true }]]);
    expect(calls.some(([target]) => target === workspace.dir)).toBe(false);
    expect(await fs.readFile(workspace.dir, "utf8")).toBe("newer");
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["off", "absent-auto", "absent-require", "missing-capability"])("removes an admitted workspace with %s native support", async (availability) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-owner-unavailable-");
    const options = { rootDir, prefix: "workspace-" };
    const opened = vi.spyOn(fsSync, "openSync");
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await workspace.write("owned.txt", "owned");
    if (availability !== "off") {
      configureFsSafeNative({ mode: availability === "absent-require" ? "require" : "auto" });
      __setNativeLoaderForTest(() => {
        if (availability === "missing-capability") return {} as NativeBinding;
        throw new Error("native binding unavailable");
      });
    }
    const retained = opened.mock.calls.flatMap(([name], index) =>
      name === rootDir && opened.mock.results[index]!.type === "return" ? [opened.mock.results[index]!.value] : []);
    const closed = vi.spyOn(fsSync, "closeSync");
    expect(await workspace.cleanup()).toBe("removed");
    for (const fd of retained) expect(closed.mock.calls.filter(([candidate]) => candidate === fd)).toHaveLength(1);
    __resetNativeLoaderForTest();
    configureFsSafeNative({ mode: "auto" });
    expect(await workspace.cleanup()).toBe("missing");
    __cleanupRegisteredTempPathsForTest();
    for (const fd of retained) expect(closed.mock.calls.filter(([candidate]) => candidate === fd)).toHaveLength(1);
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each<Cleanup>(["manual", "dispose", "exit"])("removes native-off workspaces through %s cleanup", async (method) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-owner-off-");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await workspace.write("owned.txt", "owned");
    if (method === "manual") expect(await workspace.cleanup()).toBe("removed");
    else if (method === "exit") __cleanupRegisteredTempPathsForTest();
    else if (Symbol.asyncDispose in workspace) await workspace[Symbol.asyncDispose]();
    else workspace[Symbol.dispose]();
    expect(await workspace.cleanup()).toBe("missing");
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("removes native-off withTempWorkspace data after the callback", async () => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-owner-with-off-");
    const options = { rootDir, prefix: "workspace-" };
    const dir = variant === "async"
      ? await withTempWorkspace(options, async (workspace) => {
        await workspace.write("owned.txt", "owned");
        return workspace.dir;
      })
      : withTempWorkspaceSync(options, (workspace) => {
        workspace.write("owned.txt", "owned");
        return workspace.dir;
      });
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each(["missing", "identity-mismatch"] as const)("retains initial %s admission in native-off mode", async (expected) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-owner-admission-off-");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await fs.rename(workspace.dir, `${workspace.dir}.original`);
    if (expected === "identity-mismatch") await fs.writeFile(workspace.dir, "replacement");
    expect(await workspace.cleanup()).toBe(expected);
    expect(await workspace.cleanup()).toBe(expected);
    if (expected === "identity-mismatch") expect(await fs.readFile(workspace.dir, "utf8")).toBe("replacement");
  });
});
