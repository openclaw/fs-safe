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
type SafeIdentity = Readonly<{ dev: number; ino: number }>;

function projectSafeIdentity(
  stat: { dev: number | bigint; ino: number | bigint },
  identity: SafeIdentity,
): void {
  stat.dev = typeof stat.dev === "bigint" ? BigInt(identity.dev) : identity.dev;
  stat.ino = typeof stat.ino === "bigint" ? BigInt(identity.ino) : identity.ino;
}

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

describe.each(["async", "sync"] as const)("%s compatible cleanup receipt reuse", (variant) => {
  it("pairs each named parent replay with its retained descriptor", async () => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-cleanup-receipt-");
    const admittedRoot = fsSync.realpathSync.native(rootDir);
    const options = { rootDir, prefix: "workspace-" };
    const identity = { dev: 501, ino: 601 };
    let measuring = false;
    let exactNameObservations = 0;
    let numericNameObservations = 0;
    let descriptorObservations = 0;
    let parentFd: number | undefined;
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === admittedRoot) parentFd = fd;
      return fd;
    });
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((name, statOptions) => {
      const stat = lstat(name, statOptions);
      if (name === admittedRoot) {
        projectSafeIdentity(stat, identity);
        if (measuring) {
          if (statOptions?.bigint === true) exactNameObservations += 1;
          else numericNameObservations += 1;
        }
      }
      return stat;
    });
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, statOptions) => {
      const stat = fstat(fd, statOptions);
      if (fd === parentFd) {
        projectSafeIdentity(stat, identity);
        if (measuring) descriptorObservations += 1;
      }
      return stat;
    });
    const workspace = variant === "async"
      ? await tempWorkspace(options)
      : tempWorkspaceSync(options);
    measuring = true;
    let renameObservation: number | undefined;
    let removeObservation: number | undefined;
    const rename = fsSync.renameSync.bind(fsSync);
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (from === workspace.dir) renameObservation = numericNameObservations;
      return rename(from, to);
    });
    if (variant === "async") {
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        removeObservation = numericNameObservations;
        return await rm(...args);
      });
    } else {
      const rm = fsSync.rmSync.bind(fsSync);
      vi.spyOn(fsSync, "rmSync").mockImplementation((...args) => {
        removeObservation = numericNameObservations;
        return rm(...args);
      });
    }
    expect(await workspace.cleanup()).toBe("removed");
    expect(renameObservation).toBe(3);
    expect(removeObservation).toBe(6);
    expect(exactNameObservations).toBe(0);
    expect(numericNameObservations).toBe(7);
    expect(descriptorObservations).toBe(7);
  });

  it("maps a post-removal parent replacement to an indeterminate result", async () => {
    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-temp-cleanup-parent-post-");
    const rootDir = path.join(base, "root");
    const moved = path.join(base, "moved");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async"
      ? await tempWorkspace(options)
      : tempWorkspaceSync(options);
    const replaceParent = () => {
      fsSync.renameSync(rootDir, moved);
      fsSync.mkdirSync(rootDir);
      fsSync.writeFileSync(path.join(rootDir, "keep.txt"), "replacement");
    };
    if (variant === "async") {
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementationOnce(async (...args) => {
        await rm(...args);
        replaceParent();
      });
    } else {
      const rm = fsSync.rmSync.bind(fsSync);
      vi.spyOn(fsSync, "rmSync").mockImplementationOnce((...args) => {
        rm(...args);
        replaceParent();
      });
    }
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(rootDir, "keep.txt"), "utf8")).toBe("replacement");
    expect(await fs.readdir(moved)).toEqual([]);
  });
});
