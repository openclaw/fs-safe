import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
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
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

type Replacement = "directory" | "file" | "symlink";

function installReplacement(dir: string, outside: string, kind: Replacement): BigIntStats {
  fsSync.renameSync(dir, `${dir}.original`);
  if (kind === "directory") {
    fsSync.mkdirSync(dir);
    fsSync.mkdirSync(path.join(dir, "nested"));
    fsSync.writeFileSync(path.join(dir, "nested", "keep.txt"), "replacement");
  } else if (kind === "file") {
    fsSync.writeFileSync(dir, "replacement");
  } else {
    fsSync.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
  }
  return fsSync.lstatSync(dir, { bigint: true });
}

function assertReplacementPreserved(
  dir: string,
  outside: string,
  kind: Replacement,
  identity: BigIntStats,
): void {
  expect(fsSync.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("outside");
  const current = fsSync.lstatSync(dir, { bigint: true });
  expect({ dev: current.dev, ino: current.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
  if (kind === "directory") {
    expect(fsSync.readFileSync(path.join(dir, "nested", "keep.txt"), "utf8")).toBe("replacement");
  } else if (kind === "file") {
    expect(fsSync.readFileSync(dir, "utf8")).toBe("replacement");
  } else {
    expect(fsSync.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("outside");
  }
}

describe.runIf(nativeCleanup).each(["async", "sync"] as const)("%s temp workspace owned-tree cleanup", (variant) => {
  let renameNoReplace: NativeBinding["renameNoReplace"];
  let removeOwnedTree: NonNullable<NativeBinding["removeOwnedTree"]>;
  let removeOwnedTreeSync: NonNullable<NativeBinding["removeOwnedTreeSync"]>;

  beforeEach(() => {
    configureFsSafeNative({ mode: "require" });
    renameNoReplace = native!.renameNoReplace.bind(native);
    removeOwnedTree = native!.removeOwnedTree!.bind(native);
    removeOwnedTreeSync = native!.removeOwnedTreeSync!.bind(native);
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameNoReplace: (...args) => renameNoReplace(...args),
      removeOwnedTree: (...args) => removeOwnedTree(...args),
      removeOwnedTreeSync: (...args) => removeOwnedTreeSync(...args),
    }));
  });

  async function setup() {
    const rootDir = await tempRoot("fs-safe-temp-owner-");
    const outside = await tempRoot("fs-safe-temp-owner-outside-");
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await fs.mkdir(path.join(workspace.dir, "nested"));
    await fs.writeFile(path.join(workspace.dir, "nested", "owned.txt"), "owned");
    return { workspace, outside, rootDir };
  }

  it("removes an unchanged nested workspace without pathname-recursive rm", async () => {
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    const remove = vi.fn(removeOwnedTree);
    const removeSync = vi.fn(removeOwnedTreeSync);
    removeOwnedTree = remove;
    removeOwnedTreeSync = removeSync;
    const { workspace, rootDir } = await setup();
    expect(await workspace.cleanup()).toBe("removed");
    expect(await workspace.cleanup()).toBe("missing");
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(rootDir)).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(variant === "async" ? 1 : 0);
    expect(removeSync).toHaveBeenCalledTimes(variant === "sync" ? 1 : 0);
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it.each<Replacement>(["directory", "file", "symlink"])(
    "preserves a %s replacement present before cleanup admission",
    async (kind) => {
      const { workspace, outside } = await setup();
      const replacement = installReplacement(workspace.dir, outside, kind);
      expect(await workspace.cleanup()).toBe("identity-mismatch");
      expect(await workspace.cleanup()).toBe("identity-mismatch");
      assertReplacementPreserved(workspace.dir, outside, kind, replacement);
      expect(await fs.readFile(path.join(`${workspace.dir}.original`, "nested", "owned.txt"), "utf8"))
        .toBe("owned");
    },
  );

  it("preserves a nonempty quarantine replacement installed at native removal", async () => {
    __resetNativeLoaderForTest();
    const { workspace } = await setup();
    let quarantine = "";
    const swap = vi.fn((quarantinePath: string) => {
      quarantine = quarantinePath;
      fsSync.renameSync(quarantine, `${quarantine}.owned`);
      fsSync.mkdirSync(quarantine);
      fsSync.mkdirSync(path.join(quarantine, "nested"));
      fsSync.writeFileSync(path.join(quarantine, "nested", "keep.txt"), "replacement");
    });
    __setFsSafeTestHooksForTest(variant === "async"
      ? { beforeTempWorkspaceNativeRemoval: swap }
      : { beforeTempWorkspaceNativeRemovalSync: swap });

    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(swap).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(quarantine, "nested", "keep.txt"), "utf8")).toBe("replacement");
    expect(await fs.readFile(path.join(`${quarantine}.owned`, "nested", "owned.txt"), "utf8"))
      .toBe("owned");
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the owned quarantine while preserving a newer public workspace", async () => {
    const { workspace, rootDir } = await setup();
    let publicIdentity: BigIntStats | undefined;
    let quarantineName = "";
    renameNoReplace = (...args) => {
      native!.renameNoReplace(...args);
      quarantineName = args[3];
      fsSync.mkdirSync(workspace.dir);
      fsSync.writeFileSync(path.join(workspace.dir, "keep.txt"), "replacement");
      publicIdentity = fsSync.lstatSync(workspace.dir, { bigint: true });
    };
    expect(await workspace.cleanup()).toBe("removed");
    expect(await fs.readFile(path.join(workspace.dir, "keep.txt"), "utf8")).toBe("replacement");
    expect(await fs.lstat(workspace.dir, { bigint: true })).toMatchObject({
      dev: publicIdentity!.dev,
      ino: publicIdentity!.ino,
    });
    await expect(fs.lstat(path.join(rootDir, quarantineName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "empty-directory", "nonempty-directory"])(
    "preserves a %s quarantine collision",
    async (kind) => {
      const { workspace, rootDir } = await setup();
      let quarantine = "";
      renameNoReplace = (...args) => {
        quarantine = path.join(rootDir, args[3]);
        if (kind === "file") fsSync.writeFileSync(quarantine, "collision");
        else {
          fsSync.mkdirSync(quarantine);
          if (kind === "nonempty-directory") fsSync.writeFileSync(path.join(quarantine, "keep.txt"), "collision");
        }
        native!.renameNoReplace(...args);
      };
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(await fs.readFile(path.join(workspace.dir, "nested", "owned.txt"), "utf8")).toBe("owned");
      if (kind === "empty-directory") expect(await fs.readdir(quarantine)).toEqual([]);
      else expect(await fs.readFile(kind === "file" ? quarantine : path.join(quarantine, "keep.txt"), "utf8"))
        .toBe("collision");
    },
  );

  it("maps native ownership uncertainty to indeterminate without retrying", async () => {
    const { workspace, rootDir } = await setup();
    let quarantine = "";
    renameNoReplace = (...args) => {
      native!.renameNoReplace(...args);
      quarantine = path.join(rootDir, args[3]);
    };
    const uncertain = { errorCode: "path-mismatch", errorMessage: "injected ownership drift" };
    removeOwnedTree = vi.fn(async () => uncertain);
    removeOwnedTreeSync = vi.fn(() => uncertain);
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(quarantine, "nested", "owned.txt"), "utf8"))
      .toBe("owned");
  });

  it("propagates native operational failures and closes cleanup authority", async () => {
    const { workspace } = await setup();
    const failure = { errorCode: "EACCES", errorMessage: "injected removal denial" };
    removeOwnedTree = vi.fn(async () => failure);
    removeOwnedTreeSync = vi.fn(() => failure);
    if (variant === "async") {
      await expect(workspace.cleanup()).rejects.toMatchObject({ code: "EACCES" });
    } else {
      expect(() => workspace.cleanup()).toThrowError(expect.objectContaining({ code: "EACCES" }));
    }
    expect(await workspace.cleanup()).toBe("indeterminate");
  });

  it("uses synchronous owned-tree cleanup for process-exit registration", async () => {
    const remove = vi.fn(removeOwnedTree);
    const removeSync = vi.fn(removeOwnedTreeSync);
    removeOwnedTree = remove;
    removeOwnedTreeSync = removeSync;
    const { workspace } = await setup();
    __cleanupRegisteredTempPathsForTest();
    expect(await workspace.cleanup()).toBe("missing");
    expect(remove).not.toHaveBeenCalled();
    expect(removeSync).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  if (variant === "async") {
    it("serializes concurrent cleanup calls through one native traversal", async () => {
      const remove = vi.fn(removeOwnedTree);
      removeOwnedTree = remove;
      const { workspace } = await setup();
      expect(await Promise.all([workspace.cleanup(), workspace.cleanup(), workspace.cleanup()]))
        .toEqual(["removed", "missing", "missing"]);
      expect(remove).toHaveBeenCalledTimes(1);
    });
  }
});
