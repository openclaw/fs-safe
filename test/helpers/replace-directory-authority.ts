import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../../src/native.js";
import { useRealTempDirs } from "./vitest.js";

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
    canonicalizePath: (pathname: string, ordinary: boolean) => ({
      path: ordinary ? fsSync.realpathSync(pathname) : fsSync.realpathSync.native(pathname),
    }),
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

export async function fixture(options: { distinctParents?: boolean; existingTarget?: boolean } = {}) {
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

export async function backupPaths(parent: string): Promise<string[]> {
  return (await fs.readdir(parent))
    .filter(name => name.startsWith(".fs-safe-dir-backup-"))
    .map(name => path.join(parent, name));
}
