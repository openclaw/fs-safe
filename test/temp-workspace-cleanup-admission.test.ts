import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stores from "../src/file-store.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let nativeAvailable = false;
try {
  nativeAvailable = typeof __loadBundledNativeForTest().renameNoReplace === "function";
} catch {
  // Native CI builds the binding; the fallback lane omits it.
}
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.each(["async", "sync"] as const)("%s workspace cleanup admission", (variant) => {
  describe.runIf(process.platform !== "win32").each(["require", "off"] as const)("native %s retained parent", (mode) => {
    it.each(
      (["before-cleanup", "during-lstat", "after-lstat"] as const).flatMap((when) =>
        (["missing", "replacement"] as const).map((leaf) => ({ when, leaf }))),
    )("reports indeterminate when the parent moves $when with a $leaf public leaf", async ({ when, leaf }) => {
      configureFsSafeNative({ mode });
      const base = await tempRoot("fs-safe-temp-parent-admission-");
      const rootDir = path.join(base, "parent");
      const moved = path.join(base, "moved");
      const options = { rootDir, prefix: "workspace-" };
      const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
      await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
      let ownedName = path.basename(workspace.dir);
      if (when === "after-lstat") {
        ownedName += ".owned";
        await fs.rename(workspace.dir, path.join(rootDir, ownedName));
        if (leaf === "replacement") await fs.writeFile(workspace.dir, "replacement");
      }
      const moveParent = () => {
        fsSync.renameSync(rootDir, moved);
        if (leaf === "replacement") {
          fsSync.mkdirSync(rootDir);
          fsSync.writeFileSync(workspace.dir, "replacement");
        }
      };
      const lstat = fsSync.lstatSync;
      let inspected = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        if (candidate !== workspace.dir || inspected) return lstat(candidate, options);
        inspected = true;
        if (when === "during-lstat") moveParent();
        try {
          return lstat(candidate, options);
        } finally {
          // Preserve the real stat or ENOENT while replacing its parent.
          if (when === "after-lstat") moveParent();
        }
      });
      if (when === "before-cleanup") moveParent();
      const closed = vi.spyOn(fsSync, "closeSync");
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(inspected).toBe(when !== "before-cleanup");
      expect(await workspace.cleanup()).toBe("indeterminate");
      __cleanupRegisteredTempPathsForTest();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(moved, ownedName, "owned.txt"), "utf8")).toBe("owned");
      if (leaf === "replacement") expect(await fs.readFile(workspace.dir, "utf8")).toBe("replacement");
      else await expect(fs.lstat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.runIf(nativeAvailable && process.platform !== "win32")("reports indeterminate if the parent moves during restored-leaf inspection", async () => {
    configureFsSafeNative({ mode: "require" });
    const base = await tempRoot("fs-safe-temp-restore-parent-");
    const rootDir = path.join(base, "parent");
    const moved = path.join(base, "moved");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
    const lstat = fsSync.lstatSync;
    let inspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const inspected = lstat(candidate, options);
      if (candidate === workspace.dir) {
        if (++inspections === 1) {
          fsSync.renameSync(workspace.dir, `${workspace.dir}.owned`);
          fsSync.writeFileSync(workspace.dir, "replacement");
        } else if (inspections === 2) {
          fsSync.renameSync(rootDir, moved);
        }
      }
      return inspected;
    });
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(inspections).toBe(2);
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(moved, path.basename(workspace.dir)), "utf8")).toBe("replacement");
    expect(await fs.readFile(path.join(moved, `${path.basename(workspace.dir)}.owned`, "owned.txt"), "utf8"))
      .toBe("owned");
  });

  describe.each(["require", "off"] as const)("native %s store-construction failure", (mode) => {
    it.runIf(mode === "off" || nativeAvailable).each(["owned", "replacement"])(
      "retains exit cleanup authority for the %s path",
      async (state) => {
        configureFsSafeNative({ mode });
        const rootDir = await tempRoot("fs-safe-temp-store-failure-");
        const failure = new Error("injected store construction failure");
        let dir = "";
        // Fail at the store factory itself, after real workspace creation.
        // Identity checks, registration, native rename, and deletion stay real.
        vi.spyOn(stores, variant === "async" ? "fileStore" : "fileStoreSync")
          .mockImplementationOnce((options) => {
            dir = options.rootDir;
            fsSync.writeFileSync(path.join(dir, "owned.txt"), "owned");
            throw failure;
          });
        const opened = vi.spyOn(fsSync, "openSync");
        const options = { rootDir, prefix: "workspace-" };
        await expect(async () => variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options))
          .rejects.toBe(failure);
        expect(await fs.readFile(path.join(dir, "owned.txt"), "utf8")).toBe("owned");
        const index = opened.mock.calls.findIndex(([name], index) =>
          name === rootDir && opened.mock.results[index]!.type === "return");
        const fd = index < 0 ? undefined : opened.mock.results[index]!.value as number;
        if (process.platform !== "win32") {
          expect(fd).toBeDefined();
          expect(fsSync.fstatSync(fd!).isDirectory()).toBe(true);
        }
        if (state === "replacement") {
          await fs.rename(dir, `${dir}.owned`);
          await fs.mkdir(dir);
          await fs.writeFile(path.join(dir, "keep.txt"), "replacement");
        }
        const closed = vi.spyOn(fsSync, "closeSync");
        __cleanupRegisteredTempPathsForTest();
        __cleanupRegisteredTempPathsForTest();
        if (fd !== undefined) {
          expect(closed.mock.calls.filter(([candidate]) => candidate === fd)).toHaveLength(1);
          expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        }
        if (state === "replacement") {
          expect(await fs.readFile(path.join(dir, "keep.txt"), "utf8")).toBe("replacement");
          expect(await fs.readFile(path.join(`${dir}.owned`, "owned.txt"), "utf8")).toBe("owned");
        } else {
          await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    );
  });
});
