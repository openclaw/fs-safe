import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replaceDirectoryAtomic } from "../src/atomic.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH } from "../src/native-rename-outcome.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

type RenameContext = Readonly<{ call: number; sourceName: string }>;

function sameIdentity(
  actual: BigIntStats,
  expectedDev: bigint,
  expectedIno: bigint,
): boolean {
  return actual.dev === expectedDev && actual.ino === expectedIno;
}

async function fixture() {
  const root = await tempRoot("fs-safe-replace-identity-rename-");
  const parent = path.join(root, "parent");
  const staged = path.join(parent, "staged");
  const target = path.join(parent, "target");
  await fs.mkdir(staged, { recursive: true });
  await fs.mkdir(target);
  await fs.writeFile(path.join(staged, "value.txt"), "new");
  await fs.writeFile(path.join(target, "value.txt"), "old");
  const hooks: { beforeRename?(context: RenameContext): void } = {};
  const renameNoReplaceWithIdentity = vi.fn<NonNullable<
    NativeBinding["renameNoReplaceWithIdentity"]
  >>((_, sourceName, __, targetName, expectedDev, expectedIno) => {
    const context = { call: renameNoReplaceWithIdentity.mock.calls.length, sourceName };
    hooks.beforeRename?.(context);
    const sourcePath = path.join(parent, sourceName);
    const targetPath = path.join(parent, targetName);
    const actual = fsSync.lstatSync(sourcePath, { bigint: true });
    if (!sameIdentity(actual, expectedDev, expectedIno)) {
      throw Object.assign(new Error("rename source identity changed"), {
        code: NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH,
      });
    }
    try {
      fsSync.lstatSync(targetPath);
      throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsSync.renameSync(sourcePath, targetPath);
  });
  const removeOwnedTree = vi.fn<NonNullable<NativeBinding["removeOwnedTree"]>>();
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: vi.fn(),
    renameNoReplace: vi.fn(),
    renameNoReplaceWithIdentity,
    ownedTreeRemovalAvailable: vi.fn(() => true),
    removeOwnedTree,
  }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  return { hooks, parent, removeOwnedTree, staged, target };
}

async function captureFailure(operation: Promise<void>): Promise<Error & {
  code?: string;
  details?: unknown;
}> {
  try {
    await operation;
  } catch (error) {
    return error as Error & { code?: string; details?: unknown };
  }
  throw new Error("expected directory replacement to fail");
}

async function backupPaths(parent: string): Promise<string[]> {
  return (await fs.readdir(parent))
    .filter(name => name.startsWith(".fs-safe-dir-backup-"))
    .map(name => path.join(parent, name));
}

it.each(["backup", "publish", "rollback"] as const)(
  "handles a definitely uncommitted native identity mismatch during %s",
  async phase => {
    const setup = await fixture();
    let substituted = "";
    let owned = "";
    setup.hooks.beforeRename = ({ call, sourceName }) => {
      if (phase === "rollback" && sourceName === "staged") {
        throw Object.assign(new Error("publication denied"), { code: "EACCES" });
      }
      const selected = phase === "backup" && call === 1 ||
        phase === "publish" && sourceName === "staged" ||
        phase === "rollback" && call === 3;
      if (!selected) return;
      substituted = phase === "backup"
        ? setup.target
        : phase === "publish"
          ? setup.staged
          : path.join(setup.parent, sourceName);
      owned = `${substituted}.owned`;
      fsSync.renameSync(substituted, owned);
      fsSync.mkdirSync(substituted);
      fsSync.writeFileSync(path.join(substituted, "value.txt"), "competitor");
    };

    const failure = await captureFailure(replaceDirectoryAtomic({
      stagedDir: setup.staged,
      targetDir: setup.target,
    }));

    expect(failure).toMatchObject(phase === "rollback"
      ? { code: "EACCES", details: { phase: "rollback", recovery: "backup-path-preserved" } }
      : { code: "path-mismatch", details: {
        phase,
        publication: "not-published",
        recovery: phase === "publish" ? "restored" : "none",
      } });
    if (phase === "rollback") {
      expect((failure.cause as AggregateError).errors[1])
        .toMatchObject({ code: "path-mismatch" });
    }
    expect(setup.removeOwnedTree).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(substituted, "value.txt"), "utf8"))
      .resolves.toBe("competitor");
    await expect(fs.readFile(path.join(owned, "value.txt"), "utf8"))
      .resolves.toBe(phase === "publish" ? "new" : "old");
    if (phase === "publish") {
      await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8"))
        .resolves.toBe("old");
    } else if (phase === "rollback") {
      await expect(fs.lstat(setup.target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("keeps an arbitrary native path-mismatch outcome indeterminate", async () => {
  const setup = await fixture();
  setup.hooks.beforeRename = ({ sourceName }) => {
    if (sourceName === "staged") {
      throw Object.assign(new Error("unclassified path mismatch"), { code: "path-mismatch" });
    }
  };

  const failure = await captureFailure(replaceDirectoryAtomic({
    stagedDir: setup.staged,
    targetDir: setup.target,
  }));

  expect(failure).toMatchObject({
    code: "path-mismatch",
    details: { phase: "publish", publication: "indeterminate", recovery: "backup-path-preserved" },
  });
  expect(setup.removeOwnedTree).not.toHaveBeenCalled();
  await expect(fs.lstat(setup.target)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
  const backups = await backupPaths(setup.parent);
  expect(backups).toHaveLength(1);
  await expect(fs.readFile(path.join(backups[0]!, "value.txt"), "utf8")).resolves.toBe("old");
});
