import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native CI builds the binding; the ordinary fallback lane omits it.
}
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

type Replacement = "directory" | "file" | "symlink";
type Cleanup = "manual" | "dispose" | "exit";

function installReplacement(dir: string, outside: string, kind: Replacement): BigIntStats {
  fsSync.renameSync(dir, `${dir}.original`);
  if (kind === "directory") {
    fsSync.mkdirSync(dir);
    fsSync.writeFileSync(path.join(dir, "keep.txt"), "replacement");
  } else if (kind === "file") {
    fsSync.writeFileSync(dir, "replacement");
  } else {
    // Junctions also exercise directory-link preservation without Windows symlink privileges.
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
  expect(current.isSymbolicLink()).toBe(kind === "symlink");
  expect(fsSync.readFileSync(kind === "file" ? dir : path.join(dir, "keep.txt"), "utf8"))
    .toBe(kind === "symlink" ? "outside" : "replacement");
}

describe.runIf(native && process.platform !== "win32").each(["async", "sync"] as const)("%s temp workspace cleanup ownership", (variant) => {
  let renameNoReplace: NativeBinding["renameNoReplace"];
  beforeEach(() => {
    configureFsSafeNative({ mode: "require" });
    renameNoReplace = (...args) => native!.renameNoReplace(...args);
    // Capture the binding before creation; each test arms a race at its real rename.
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameNoReplace: (...args) => renameNoReplace(...args),
    }));
  });

  async function setup() {
    const rootDir = await tempRoot("fs-safe-temp-owner-");
    const outside = await tempRoot("fs-safe-temp-owner-outside-");
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    await workspace.write("owned.txt", "owned");
    return { workspace, outside, rootDir };
  }

  async function cleanup(workspace: Awaited<ReturnType<typeof setup>>["workspace"], method: Cleanup) {
    if (method === "manual") return await workspace.cleanup();
    if (method === "exit") return __cleanupRegisteredTempPathsForTest();
    if (Symbol.asyncDispose in workspace) return await workspace[Symbol.asyncDispose]();
    return workspace[Symbol.dispose]();
  }

  it("removes an unchanged workspace and reports missing on repeated cleanup", async () => {
    const { workspace } = await setup();
    expect(await workspace.cleanup()).toBe("removed");
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await workspace.cleanup()).toBe("missing");
  });

  it.each<Replacement>(["directory", "file", "symlink"])(
    "preserves a %s replacement present before identity inspection",
    async (kind) => {
      const { workspace, outside } = await setup();
      const replacement = installReplacement(workspace.dir, outside, kind);
      expect(await workspace.cleanup()).toBe("identity-mismatch");
      assertReplacementPreserved(workspace.dir, outside, kind, replacement);
    },
  );

  it.each<Replacement>(["directory", "file", "symlink"])(
    "preserves both the quarantined %s and a newer public entry during restore",
    async (kind) => {
      const { workspace, outside, rootDir } = await setup();
      let quarantine = "";
      let replacement: BigIntStats | undefined;
      let renames = 0;
      renameNoReplace = (...args) => {
        if (renames++ === 0) {
          replacement = installReplacement(workspace.dir, outside, kind);
          quarantine = path.join(rootDir, args[3]);
        } else {
          fsSync.mkdirSync(workspace.dir);
          fsSync.writeFileSync(path.join(workspace.dir, "newer.txt"), "newer");
        }
        native!.renameNoReplace(...args);
      };
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(renames).toBe(2);
      expect(await workspace.cleanup()).toBe("indeterminate");
      assertReplacementPreserved(quarantine, outside, kind, replacement!);
      expect(await fs.readFile(path.join(workspace.dir, "newer.txt"), "utf8")).toBe("newer");
      expect(await fs.readFile(path.join(`${workspace.dir}.original`, "owned.txt"), "utf8")).toBe("owned");
    },
  );

  it.each(["before-quarantine", "after-quarantine"])("preserves all entries when the retained parent moves %s", async (when) => {
    const { workspace, rootDir } = await setup();
    const moved = path.join(await tempRoot("fs-safe-temp-owner-moved-"), "parent");
    let quarantineName = "";
    renameNoReplace = (...args) => {
      quarantineName = args[3];
      const move = () => {
        fsSync.renameSync(rootDir, moved);
        fsSync.mkdirSync(rootDir);
        fsSync.mkdirSync(workspace.dir);
        fsSync.writeFileSync(path.join(workspace.dir, "newer.txt"), "newer");
        fsSync.mkdirSync(path.join(rootDir, quarantineName));
        fsSync.writeFileSync(path.join(rootDir, quarantineName, "keep.txt"), "keep");
      };
      if (when === "before-quarantine") move();
      native!.renameNoReplace(...args);
      if (when === "after-quarantine") move();
    };
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(moved, quarantineName, "owned.txt"), "utf8")).toBe("owned");
    expect(await fs.readFile(path.join(workspace.dir, "newer.txt"), "utf8")).toBe("newer");
    expect(await fs.readFile(path.join(rootDir, quarantineName, "keep.txt"), "utf8")).toBe("keep");
  });

  it("preserves a public replacement installed after the owned directory is quarantined", async () => {
    const { workspace, outside, rootDir } = await setup();
    let replacement: BigIntStats | undefined;
    let quarantineName = "";
    renameNoReplace = (...args) => {
      native!.renameNoReplace(...args);
      quarantineName = args[3];
      fsSync.mkdirSync(workspace.dir);
      fsSync.writeFileSync(path.join(workspace.dir, "keep.txt"), "replacement");
      replacement = fsSync.lstatSync(workspace.dir, { bigint: true });
    };
    expect(await workspace.cleanup()).toBe("removed");
    expect(await workspace.cleanup()).toBe("missing");
    assertReplacementPreserved(workspace.dir, outside, "directory", replacement!);
    await expect(fs.lstat(path.join(rootDir, quarantineName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "empty-directory", "nonempty-directory"])("preserves a %s quarantine collision without overwriting it", async (kind) => {
    const { workspace, rootDir } = await setup();
    let quarantine = "";
    let collision: BigIntStats | undefined;
    renameNoReplace = (...args) => {
      quarantine = path.join(rootDir, args[3]);
      if (kind === "file") fsSync.writeFileSync(quarantine, "collision");
      else {
        fsSync.mkdirSync(quarantine);
        if (kind === "nonempty-directory") fsSync.writeFileSync(path.join(quarantine, "keep.txt"), "collision");
      }
      collision = fsSync.lstatSync(quarantine, { bigint: true });
      native!.renameNoReplace(...args);
    };
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(workspace.dir, "owned.txt"), "utf8")).toBe("owned");
    expect(await fs.lstat(quarantine, { bigint: true })).toMatchObject({ dev: collision!.dev, ino: collision!.ino });
    if (kind === "empty-directory") expect(await fs.readdir(quarantine)).toEqual([]);
    else expect(await fs.readFile(kind === "file" ? quarantine : path.join(quarantine, "keep.txt"), "utf8")).toBe("collision");
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it.each(["before-rename", "after-rename"])("preserves entries after an ambiguous native error %s", async (when) => {
    const { workspace, rootDir } = await setup();
    let quarantine = "";
    renameNoReplace = (...args) => {
      quarantine = path.join(rootDir, args[3]);
      if (when === "after-rename") native!.renameNoReplace(...args);
      throw Object.assign(new Error("rename outcome unknown"), { code: "EIO" });
    };
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(await fs.readFile(path.join(when === "before-rename" ? workspace.dir : quarantine, "owned.txt"), "utf8"))
      .toBe("owned");
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("preserves quarantine mutation detected before recursive removal", async () => {
    const { workspace, rootDir } = await setup();
    let quarantine = "";
    renameNoReplace = (...args) => {
      native!.renameNoReplace(...args);
      quarantine = path.join(rootDir, args[3]);
    };
    const lstat = fsSync.lstatSync;
    let inspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const inspected = lstat(candidate, options);
      if (candidate === quarantine && ++inspections === 1) {
        fsSync.renameSync(quarantine, `${quarantine}.owned`);
        fsSync.mkdirSync(quarantine);
        fsSync.writeFileSync(path.join(quarantine, "keep.txt"), "replacement");
      }
      return inspected;
    });
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(inspections).toBe(2);
    expect(await fs.readFile(path.join(quarantine, "keep.txt"), "utf8")).toBe("replacement");
    expect(await fs.readFile(path.join(`${quarantine}.owned`, "owned.txt"), "utf8")).toBe("owned");
    expect(rm).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("reports a missing public name without following the renamed workspace", async () => {
    const { workspace } = await setup();
    await fs.rename(workspace.dir, `${workspace.dir}.owned`);
    expect(await workspace.cleanup()).toBe("missing");
    expect(await workspace.cleanup()).toBe("missing");
    expect(await fs.readFile(path.join(`${workspace.dir}.owned`, "owned.txt"), "utf8")).toBe("owned");
  });

  it.each<Cleanup>(["manual", "dispose", "exit"])("closes the retained parent exactly once after %s cleanup", async (method) => {
    const opened = vi.spyOn(fsSync, "openSync");
    const { workspace, rootDir } = await setup();
    const index = opened.mock.calls.findIndex(([name]) => name === rootDir);
    expect(index).toBeGreaterThanOrEqual(0);
    const fd = opened.mock.results[index]!.value as number;
    const closed = vi.spyOn(fsSync, "closeSync");
    await cleanup(workspace, method);
    expect(await workspace.cleanup()).toBe("missing");
    __cleanupRegisteredTempPathsForTest();
    expect(closed.mock.calls.filter(([candidate]) => candidate === fd)).toHaveLength(1);
    expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
  });

  it("serializes concurrent cleanup calls", async () => {
    const { workspace } = await setup();
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    expect(await Promise.all([workspace.cleanup(), workspace.cleanup(), workspace.cleanup()]))
      .toEqual(["removed", "missing", "missing"]);
    const calls = [...rm.mock.calls, ...rmSync.mock.calls];
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).not.toBe(workspace.dir);
    expect(path.basename(String(calls[0]![0]))).toMatch(/^\.fs-safe-workspace-cleanup-[\da-f-]+$/);
    expect(calls[0]![1]).toEqual({ recursive: true, force: true });
  });

  it("revalidates the retained parent after quarantine inspection and before removal", async () => {
    const { workspace, rootDir } = await setup();
    const moved = path.join(await tempRoot("fs-safe-temp-owner-late-move-"), "parent");
    let quarantine = "";
    renameNoReplace = (...args) => {
      native!.renameNoReplace(...args);
      quarantine = path.join(rootDir, args[3]);
    };
    const lstat = fsSync.lstatSync;
    let inspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const inspected = lstat(candidate, options);
      if (candidate === quarantine && ++inspections === 2) {
        fsSync.renameSync(rootDir, moved);
        fsSync.mkdirSync(rootDir);
        fsSync.mkdirSync(quarantine);
        fsSync.writeFileSync(path.join(quarantine, "keep.txt"), "replacement");
      }
      return inspected;
    });
    expect(await workspace.cleanup()).toBe("indeterminate");
    expect(inspections).toBe(2);
    expect(await fs.readFile(path.join(quarantine, "keep.txt"), "utf8")).toBe("replacement");
    expect(await fs.readFile(path.join(moved, path.basename(quarantine), "owned.txt"), "utf8")).toBe("owned");
  });

  if (variant === "async") {
    it("closes once and preserves quarantine when exit interrupts async cleanup before removal", async () => {
      const { workspace, rootDir } = await setup();
      let quarantine = "";
      renameNoReplace = (...args) => {
        native!.renameNoReplace(...args);
        quarantine = path.join(rootDir, args[3]);
      };
      const lstat = fs.lstat;
      let exited = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
        const inspected = await lstat(candidate, options);
        if (candidate === rootDir && !exited) {
          exited = true;
          __cleanupRegisteredTempPathsForTest();
        }
        return inspected;
      });
      const closed = vi.spyOn(fsSync, "closeSync");
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(exited).toBe(true);
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(closed).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(quarantine, "owned.txt"), "utf8")).toBe("owned");
    });
  }

  it.runIf(process.getuid?.() !== 0)("propagates real removal errors and closes without retrying deletion", async () => {
    const { workspace, rootDir } = await setup();
    let quarantine = "";
    renameNoReplace = (...args) => {
      native!.renameNoReplace(...args);
      quarantine = path.join(rootDir, args[3]);
      fsSync.chmodSync(quarantine, 0);
    };
    const closed = vi.spyOn(fsSync, "closeSync");
    try {
      await expect(async () => await workspace.cleanup()).rejects.toMatchObject({ code: "EACCES" });
      expect(await workspace.cleanup()).toBe("indeterminate");
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      if (quarantine) await fs.chmod(quarantine, 0o700);
    }
    expect(await fs.readFile(path.join(quarantine, "owned.txt"), "utf8")).toBe("owned");
  });

  describe.each<Cleanup>(["manual", "dispose", "exit"])("%s cleanup", (method) => {
    it.each<Replacement>(["directory", "file", "symlink"])(
      "preserves a %s replacement installed after identity inspection",
      async (kind) => {
        const { workspace, outside } = await setup();
        let replacement: BigIntStats | undefined;
        let swapped = false;
        const swap = () => {
          swapped = true;
          replacement = installReplacement(workspace.dir, outside, kind);
          expect(fsSync.readFileSync(path.join(`${workspace.dir}.original`, "owned.txt"), "utf8"))
            .toBe("owned");
        };

        // Interpose at the real no-replace rename, after identity admission.
        // Both rename calls and recursive deletion still execute on real disk.
        let renames = 0;
        renameNoReplace = (...args) => {
          if (renames++ === 0) swap();
          native!.renameNoReplace(...args);
        };

        try {
          const result = await cleanup(workspace, method);
          if (method === "manual") expect(result).toBe("identity-mismatch");
          expect(renames).toBe(2);
          expect(await workspace.cleanup()).toBe("identity-mismatch");
          expect(swapped).toBe(true);
          expect(replacement).toBeDefined();
          assertReplacementPreserved(workspace.dir, outside, kind, replacement!);
        } finally {
          vi.restoreAllMocks();
          // Unregister even when an assertion fails; never leave this fixture
          // available to a later test's process-exit cleanup simulation.
          await workspace.cleanup();
        }
      },
    );
  });
});
