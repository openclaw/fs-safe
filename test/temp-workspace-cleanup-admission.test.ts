import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stores from "../src/file-store.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native CI builds the binding; ordinary JavaScript lanes skip this suite.
}
const nativeCleanup = native && typeof native.removeOwnedTree === "function" &&
  typeof native.removeOwnedTreeSync === "function";
const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.runIf(nativeCleanup).each(["async", "sync"] as const)("%s workspace cleanup admission", (variant) => {
  async function create(rootDir: string) {
    const options = { rootDir, prefix: "workspace-" };
    return variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
  }

  it.runIf(process.platform !== "win32").each(["missing", "replacement"] as const)(
    "reports indeterminate when the retained parent moves before cleanup with a %s public leaf",
    async (leaf) => {
      configureFsSafeNative({ mode: "require" });
      const base = await tempRoot("fs-safe-temp-parent-before-");
      const rootDir = path.join(base, "parent");
      const moved = path.join(base, "moved");
      const workspace = await create(rootDir);
      await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
      const ownedName = path.basename(workspace.dir);
      fsSync.renameSync(rootDir, moved);
      if (leaf === "replacement") {
        fsSync.mkdirSync(rootDir);
        fsSync.mkdirSync(workspace.dir);
        fsSync.writeFileSync(path.join(workspace.dir, "keep.txt"), "replacement");
      }
      const closed = vi.spyOn(fsSync, "closeSync");
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(await fs.readFile(path.join(moved, ownedName, "owned.txt"), "utf8")).toBe("owned");
      if (leaf === "replacement") {
        expect(await fs.readFile(path.join(workspace.dir, "keep.txt"), "utf8")).toBe("replacement");
      }
      expect(closed).toHaveBeenCalledTimes(2);
    },
  );

  it.runIf(process.platform !== "win32")(
    "continues through the retained parent if its pathname moves after quarantine",
    async () => {
    configureFsSafeNative({ mode: "require" });
    const base = await tempRoot("fs-safe-temp-parent-after-");
    const rootDir = path.join(base, "parent");
    const moved = path.join(base, "moved");
    let replacement = "";
    const remove = native!.removeOwnedTree!.bind(native);
    const removeSync = native!.removeOwnedTreeSync!.bind(native);
    __setNativeLoaderForTest(() => ({
      ...native!,
      removeOwnedTree: async (...args) => {
        fsSync.renameSync(rootDir, moved);
        fsSync.mkdirSync(rootDir);
        replacement = path.join(rootDir, args[1]);
        fsSync.mkdirSync(replacement);
        fsSync.writeFileSync(path.join(replacement, "keep.txt"), "replacement");
        return await remove(...args);
      },
      removeOwnedTreeSync: (...args) => {
        fsSync.renameSync(rootDir, moved);
        fsSync.mkdirSync(rootDir);
        replacement = path.join(rootDir, args[1]);
        fsSync.mkdirSync(replacement);
        fsSync.writeFileSync(path.join(replacement, "keep.txt"), "replacement");
        return removeSync(...args);
      },
    }));
    const workspace = await create(rootDir);
    await fs.mkdir(path.join(workspace.dir, "nested"));
    await fs.writeFile(path.join(workspace.dir, "nested", "owned.txt"), "owned");
    expect(await workspace.cleanup()).toBe("removed");
    expect(await fs.readFile(path.join(replacement, "keep.txt"), "utf8")).toBe("replacement");
      expect(await fs.readdir(moved)).toEqual([]);
    },
  );

  it.each(["owned", "replacement"] as const)(
    "retains exit cleanup authority after a store-construction failure with %s path state",
    async (state) => {
      configureFsSafeNative({ mode: "require" });
      const rootDir = await tempRoot("fs-safe-temp-store-failure-");
      const failure = new Error("injected store construction failure");
      let dir = "";
      vi.spyOn(stores, variant === "async" ? "fileStore" : "fileStoreSync")
        .mockImplementationOnce((options) => {
          dir = options.rootDir;
          fsSync.writeFileSync(path.join(dir, "owned.txt"), "owned");
          throw failure;
        });
      await expect(async () => variant === "async"
        ? await tempWorkspace({ rootDir, prefix: "workspace-" })
        : tempWorkspaceSync({ rootDir, prefix: "workspace-" }))
        .rejects.toBe(failure);
      if (state === "replacement") {
        await fs.rename(dir, `${dir}.owned`);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "keep.txt"), "replacement");
      }
      __cleanupRegisteredTempPathsForTest();
      if (state === "replacement") {
        expect(await fs.readFile(path.join(dir, "keep.txt"), "utf8")).toBe("replacement");
        expect(await fs.readFile(path.join(`${dir}.owned`, "owned.txt"), "utf8")).toBe("owned");
      } else {
        await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
