import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceDirectoryAtomic } from "../src/atomic.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

type RenameContext = Readonly<{
  call: number;
  sourceName: string;
  targetName: string;
}>;

type AdapterHooks = {
  beforeRename?(context: RenameContext): void;
  afterRename?(context: RenameContext): void;
  beforeRemove?(backupPath: string): void;
};

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function replacementAdapter(
  parentPaths: () => readonly string[],
  hooks: AdapterHooks = {},
) {
  const parentFds = new Set<number>();
  const originalFds = new Set<number>();
  const parentForFd = (fd: number): string => {
    parentFds.add(fd);
    const descriptor = fsSync.fstatSync(fd, { bigint: true });
    for (const candidate of parentPaths()) {
      try {
        const current = fsSync.lstatSync(candidate, { bigint: true });
        if (current.isDirectory() && sameIdentity(current, descriptor)) return candidate;
      } catch {
        // The retained parent can have moved; another candidate may name it.
      }
    }
    throw new Error("test adapter could not associate a retained parent descriptor");
  };

  const renameNoReplace = vi.fn<NonNullable<NativeBinding["renameNoReplaceWithIdentity"]>>((
    sourceParentFd,
    sourceName,
    targetParentFd,
    targetName,
  ) => {
    const context = {
      call: renameNoReplace.mock.calls.length,
      sourceName,
      targetName,
    };
    hooks.beforeRename?.(context);
    const source = path.join(parentForFd(sourceParentFd), sourceName);
    const target = path.join(parentForFd(targetParentFd), targetName);
    try {
      fsSync.lstatSync(target);
      throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsSync.renameSync(source, target);
    hooks.afterRename?.(context);
  });

  const removeOwnedTree = vi.fn<NonNullable<NativeBinding["removeOwnedTree"]>>(
    async (parentFd, backupName, directoryFd) => {
      originalFds.add(directoryFd);
      const backupPath = path.join(parentForFd(parentFd), backupName);
      hooks.beforeRemove?.(backupPath);
      let current: BigIntStats;
      try {
        current = fsSync.lstatSync(backupPath, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "preserved" };
        throw error;
      }
      const retained = fsSync.fstatSync(directoryFd, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(current, retained)) {
        return { outcome: "preserved" };
      }
      await fs.rm(backupPath, { recursive: true });
      return { outcome: "removed" };
    },
  );
  const ownedTreeRemovalAvailable = vi.fn(() => true);
  const binding = {
    closeOwnedFd: vi.fn(),
    renameNoReplace: vi.fn(),
    renameNoReplaceWithIdentity: renameNoReplace,
    removeOwnedTree,
    ownedTreeRemovalAvailable,
  } as unknown as NativeBinding;
  return {
    binding,
    hooks,
    originalFds,
    parentFds,
    removeOwnedTree,
    renameNoReplace,
  };
}

async function fixture(options: { distinctParents?: boolean; existingTarget?: boolean } = {}) {
  const root = await tempRoot("fs-safe-replace-authority-");
  const targetParent = path.join(root, "target-parent");
  const stagedParent = options.distinctParents
    ? path.join(root, "staged-parent")
    : targetParent;
  await fs.mkdir(targetParent);
  if (stagedParent !== targetParent) await fs.mkdir(stagedParent);
  const target = path.join(targetParent, "target");
  const staged = path.join(stagedParent, "staged");
  await fs.mkdir(staged);
  await fs.writeFile(path.join(staged, "value.txt"), "new");
  if (options.existingTarget !== false) {
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "value.txt"), "old");
  }
  const additionalParents: string[] = [];
  const hooks: AdapterHooks = {};
  const adapter = replacementAdapter(
    () => [targetParent, stagedParent, ...additionalParents],
    hooks,
  );
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });
  return {
    ...adapter,
    additionalParents,
    root,
    staged,
    stagedParent,
    target,
    targetParent,
  };
}

async function backupPaths(parent: string): Promise<string[]> {
  return (await fs.readdir(parent))
    .filter(name => name.startsWith(".fs-safe-dir-backup-"))
    .map(name => path.join(parent, name));
}

describe("retained directory replacement authority", () => {
  it("fails before mutation when native no-replace authority is unavailable", async () => {
    const setup = await fixture({ existingTarget: false });
    const loader = vi.fn(() => setup.binding);
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode: "off" });

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({ code: "helper-unavailable" });

    expect(loader).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.lstat(setup.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])(
    "publishes an absent target through retained parents (distinct=%s)",
    async distinctParents => {
      const setup = await fixture({ distinctParents, existingTarget: false });
      const stagedIdentity = await fs.lstat(setup.staged, { bigint: true });

      await replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target });

      expect(setup.renameNoReplace).toHaveBeenCalledOnce();
      const [sourceFd, , targetFd, , expectedDev, expectedIno] = setup.renameNoReplace.mock.calls[0]!;
      expect(sourceFd === targetFd).toBe(!distinctParents);
      expect([expectedDev, expectedIno]).toEqual([stagedIdentity.dev, stagedIdentity.ino]);
      expect(setup.removeOwnedTree).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8"))
        .resolves.toBe("new");
    },
  );

  it("accepts distinct ordinary and native spellings for the same retained parent", async () => {
    const setup = await fixture({ existingTarget: false });
    const resolveNative = realpathSync.native;
    const parentCanonical = resolveNative(setup.targetParent);
    const nativeSpelling = `${parentCanonical}.native-spelling`;
    vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      const resolved = resolveNative(candidate);
      return resolved === parentCanonical ? nativeSpelling : resolved;
    });

    await replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target });

    expect(setup.renameNoReplace).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8"))
      .resolves.toBe("new");
  });

  it.each([false, true])(
    "replaces and cleans an existing target through retained ownership (distinct=%s)",
    async distinctParents => {
      const setup = await fixture({ distinctParents });

      await replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target });

      expect(setup.renameNoReplace).toHaveBeenCalledTimes(2);
      expect(setup.removeOwnedTree).toHaveBeenCalledOnce();
      expect(await backupPaths(setup.targetParent)).toEqual([]);
      await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8"))
        .resolves.toBe("new");
    },
  );

  it.each(
    [false, true].flatMap(existingTarget =>
      [false, true].map(distinctParents => ({ distinctParents, existingTarget }))),
  )(
    "preserves a publication competitor (existing=$existingTarget distinct=$distinctParents)",
    async ({ distinctParents, existingTarget }) => {
      const setup = await fixture({ distinctParents, existingTarget });
      setup.hooks.beforeRename = ({ sourceName }) => {
        if (sourceName !== "staged") return;
        fsSync.mkdirSync(setup.target);
        fsSync.writeFileSync(path.join(setup.target, "value.txt"), "competitor");
      };

      await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
        .rejects.toMatchObject(existingTarget
          ? { details: { phase: "rollback", recovery: "backup-path-preserved" } }
          : { details: { phase: "publish", publication: "not-published" } });

      await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8"))
        .resolves.toBe("competitor");
      await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
      const backups = await backupPaths(setup.targetParent);
      expect(backups).toHaveLength(existingTarget ? 1 : 0);
      if (backups[0]) {
        await expect(fs.readFile(path.join(backups[0], "value.txt"), "utf8"))
          .resolves.toBe("old");
      }
    },
  );

  it("rolls back through no-replace after a definite publication failure", async () => {
    const setup = await fixture();
    setup.hooks.beforeRename = ({ sourceName }) => {
      if (sourceName === "staged") {
        throw Object.assign(new Error("publication denied"), { code: "EACCES" });
      }
    };

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        code: "EACCES",
        details: { phase: "publish", publication: "not-published", recovery: "restored" },
      });

    expect(setup.renameNoReplace).toHaveBeenCalledTimes(3);
    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
    expect(await backupPaths(setup.targetParent)).toEqual([]);
  });

  it.each(["backup", "publish", "rollback"] as const)(
    "preserves names after an indeterminate %s rename error",
    async phase => {
      const setup = await fixture();
      setup.hooks.beforeRename = ({ call, sourceName }) => {
        const selected = phase === "backup" && call === 1 ||
          phase === "publish" && sourceName === "staged" ||
          phase === "rollback" && call === 3;
        if (selected) throw Object.assign(new Error("remote outcome unknown"), { code: "EIO" });
        if (phase === "rollback" && sourceName === "staged") {
          throw Object.assign(new Error("definite publication failure"), { code: "EACCES" });
        }
      };

      await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
        .rejects.toMatchObject(phase === "backup"
          ? { details: { phase: "backup", recovery: "indeterminate" } }
          : phase === "publish"
            ? { details: { phase: "publish", publication: "indeterminate" } }
            : { details: { phase: "rollback", recovery: "indeterminate" } });

      expect(setup.removeOwnedTree).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
      if (phase === "backup") {
        await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("old");
      } else {
        await expect(fs.lstat(setup.target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await backupPaths(setup.targetParent)).toHaveLength(1);
      }
    },
  );

  it("reports an indeterminate publication that committed before its error", async () => {
    const setup = await fixture();
    setup.hooks.afterRename = ({ sourceName }) => {
      if (sourceName === "staged") {
        throw Object.assign(new Error("remote acknowledgement lost"), { code: "EIO" });
      }
    };

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        details: { phase: "publish", publication: "indeterminate", recovery: "backup-path-preserved" },
      });

    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("new");
    expect(await backupPaths(setup.targetParent)).toHaveLength(1);
    expect(setup.removeOwnedTree).not.toHaveBeenCalled();
  });

  it("rejects a staged replacement observed after backup and restores the original", async () => {
    const setup = await fixture();
    const originalStage = `${setup.staged}.original`;
    setup.hooks.afterRename = ({ sourceName }) => {
      if (sourceName !== "target") return;
      fsSync.renameSync(setup.staged, originalStage);
      fsSync.mkdirSync(setup.staged);
      fsSync.writeFileSync(path.join(setup.staged, "value.txt"), "replacement-stage");
    };

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        code: "path-mismatch",
        details: { publication: "not-published", recovery: "restored" },
      });

    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8"))
      .resolves.toBe("replacement-stage");
    await expect(fs.readFile(path.join(originalStage, "value.txt"), "utf8")).resolves.toBe("new");
  });

  it("never rolls back or cleans after committed publication verification fails", async () => {
    const setup = await fixture();
    const published = `${setup.target}.published`;
    setup.hooks.afterRename = ({ sourceName }) => {
      if (sourceName !== "staged") return;
      fsSync.renameSync(setup.target, published);
      fsSync.mkdirSync(setup.target);
      fsSync.writeFileSync(path.join(setup.target, "value.txt"), "competitor");
    };

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        code: "path-mismatch",
        details: { publication: "published", recovery: "backup-path-preserved" },
      });

    expect(setup.renameNoReplace).toHaveBeenCalledTimes(2);
    expect(setup.removeOwnedTree).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8"))
      .resolves.toBe("competitor");
    await expect(fs.readFile(path.join(published, "value.txt"), "utf8")).resolves.toBe("new");
    expect(await backupPaths(setup.targetParent)).toHaveLength(1);
  });

  it("preserves a substituted backup at bounded cleanup dispatch", async () => {
    const setup = await fixture();
    let ownedBackup = "";
    let replacementBackup = "";
    setup.hooks.beforeRemove = backupPath => {
      replacementBackup = backupPath;
      ownedBackup = `${backupPath}.owned`;
      fsSync.renameSync(backupPath, ownedBackup);
      fsSync.mkdirSync(backupPath);
      fsSync.writeFileSync(path.join(backupPath, "keep.txt"), "replacement");
    };

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        code: "path-mismatch",
        details: { phase: "cleanup", publication: "published", recovery: "cleanup-incomplete" },
      });

    await expect(fs.readFile(path.join(replacementBackup, "keep.txt"), "utf8"))
      .resolves.toBe("replacement");
    await expect(fs.readFile(path.join(ownedBackup, "value.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("new");
  });

  it("preserves operational cleanup failures and committed state", async () => {
    const setup = await fixture();
    setup.removeOwnedTree.mockResolvedValue({
      errorCode: "EACCES",
      errorMessage: "cleanup denied",
    });

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        code: "EACCES",
        details: { phase: "cleanup", publication: "published", recovery: "cleanup-incomplete" },
      });

    expect(await backupPaths(setup.targetParent)).toHaveLength(1);
    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("new");
  });

  it("uses the retained parent when its pathname is replaced", async () => {
    const setup = await fixture({ existingTarget: false });
    const parkedParent = `${setup.targetParent}.parked`;
    setup.additionalParents.push(parkedParent);
    setup.hooks.beforeRename = () => {
      fsSync.renameSync(setup.targetParent, parkedParent);
      fsSync.mkdirSync(setup.targetParent);
      fsSync.writeFileSync(path.join(setup.targetParent, "keep.txt"), "replacement-parent");
      setup.hooks.beforeRename = undefined;
    };

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({ details: { publication: "published" } });

    await expect(fs.readFile(path.join(setup.targetParent, "keep.txt"), "utf8"))
      .resolves.toBe("replacement-parent");
    await expect(fs.readFile(path.join(parkedParent, "target", "value.txt"), "utf8"))
      .resolves.toBe("new");
  });

  it("closes an already retained parent when distinct-parent admission fails", async () => {
    const setup = await fixture({ distinctParents: true, existingTarget: false });
    const openSync = fsSync.openSync.bind(fsSync);
    const closeSync = fsSync.closeSync.bind(fsSync);
    const openedTargetParents: number[] = [];
    const closed: number[] = [];
    vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
      if (String(pathname) === setup.stagedParent) {
        throw Object.assign(new Error("staged parent unreadable"), { code: "EACCES" });
      }
      const fd = openSync(pathname, flags, mode);
      if (String(pathname) === setup.targetParent) openedTargetParents.push(fd);
      return fd;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      closed.push(fd);
      closeSync(fd);
    });

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({ code: "helper-unavailable" });

    expect(openedTargetParents).toHaveLength(1);
    expect(closed).toContain(openedTargetParents[0]);
    expect(setup.renameNoReplace).not.toHaveBeenCalled();
  });

  it("preserves the primary failure and recovery details when descriptor close also fails", async () => {
    const setup = await fixture();
    setup.hooks.beforeRename = ({ sourceName }) => {
      if (sourceName === "staged") {
        throw Object.assign(new Error("publication denied"), { code: "EACCES" });
      }
    };
    const closeSync = fsSync.closeSync.bind(fsSync);
    let injected = false;
    vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      closeSync(fd);
      if (!injected && (setup.parentFds.has(fd) || setup.originalFds.has(fd))) {
        injected = true;
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      }
    });

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({
        code: "EACCES",
        details: { publication: "not-published", recovery: "restored" },
      });

    expect(injected).toBe(true);
    await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("old");
  });

  it("rejects a non-directory target without moving either endpoint", async () => {
    const setup = await fixture({ existingTarget: false });
    await fs.writeFile(setup.target, "not a directory");

    await expect(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }))
      .rejects.toMatchObject({ code: "not-file" });

    expect(setup.renameNoReplace).not.toHaveBeenCalled();
    await expect(fs.readFile(setup.target, "utf8")).resolves.toBe("not a directory");
    await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
  });
});
