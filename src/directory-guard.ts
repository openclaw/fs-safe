import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";
import {
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type AsyncDirectoryGuard<T extends Stats | BigIntStats = Stats> = {
  dir: string;
  realPath: string;
  stat: T;
};

export type AnyAsyncDirectoryGuard = AsyncDirectoryGuard<Stats | BigIntStats>;

export type SyncDirectoryGuard = {
  dir: string;
  realPath: string;
  stat: Stats;
};

export function createAsyncDirectoryGuard(dir: string, options: { bigint: true }): Promise<AsyncDirectoryGuard<BigIntStats>>;
export function createAsyncDirectoryGuard(dir: string, options?: { bigint?: false }): Promise<AsyncDirectoryGuard>;
export function createAsyncDirectoryGuard(dir: string, options: { bigint: boolean }): Promise<AnyAsyncDirectoryGuard>;
export async function createAsyncDirectoryGuard(dir: string, options?: { bigint?: boolean }): Promise<AnyAsyncDirectoryGuard> {
  const operationPath = pathForWindowsFilesystem(dir);
  const stat = options?.bigint
    ? inspectDirectoryIdentitySync(operationPath)
    : fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  return { dir, realPath: fsSync.realpathSync.native(operationPath), stat };
}

export async function assertAsyncDirectoryGuard(guard: AnyAsyncDirectoryGuard): Promise<void> {
  const operationPath = pathForWindowsFilesystem(guard.dir);
  const stat = typeof guard.stat.dev === "bigint" && typeof guard.stat.ino === "bigint"
    ? inspectDirectoryIdentitySync(operationPath, { dev: guard.stat.dev, ino: guard.stat.ino })
    : fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  if (
    !sameFileIdentity(stat, guard.stat) ||
    fsSync.realpathSync.native(operationPath) !== guard.realPath
  ) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export function createSyncDirectoryGuard(dir: string): SyncDirectoryGuard {
  const operationPath = pathForWindowsFilesystem(dir);
  const stat = fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  return { dir, realPath: fsSync.realpathSync(operationPath), stat };
}

export function assertSyncDirectoryGuard(guard: SyncDirectoryGuard | AnyAsyncDirectoryGuard): void {
  const operationPath = pathForWindowsFilesystem(guard.dir);
  const stat = typeof guard.stat.dev === "bigint" && typeof guard.stat.ino === "bigint"
    ? inspectFileIdentitySync(
      () => fsSync.lstatSync(operationPath, { bigint: true }),
      { dev: guard.stat.dev, ino: guard.stat.ino },
    )
    : fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  const realPath = typeof guard.stat.ino === "bigint"
    ? fsSync.realpathSync.native(operationPath) : fsSync.realpathSync(operationPath);
  if (!sameFileIdentity(stat, guard.stat) || realPath !== guard.realPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export function createNearestExistingDirectoryGuard(rootReal: string, targetPath: string): Promise<AsyncDirectoryGuard>;
export function createNearestExistingDirectoryGuard(rootReal: string, targetPath: string, options: { bigint: boolean }): Promise<AnyAsyncDirectoryGuard>;
export async function createNearestExistingDirectoryGuard(
  rootReal: string,
  targetPath: string,
  options = { bigint: false },
): Promise<AnyAsyncDirectoryGuard> {
  let current = resolvePathPreservingWindowsRoot(targetPath);
  const root = resolvePathPreservingWindowsRoot(rootReal);
  while (current !== root) {
    try {
      return await createAsyncDirectoryGuard(current, options);
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      current = path.dirname(current);
    }
  }
  return await createAsyncDirectoryGuard(root, options);
}

export function createNearestExistingSyncDirectoryGuard(
  rootReal: string,
  targetPath: string,
): SyncDirectoryGuard {
  let current = resolvePathPreservingWindowsRoot(targetPath);
  const root = resolvePathPreservingWindowsRoot(rootReal);
  while (current !== root) {
    try {
      return createSyncDirectoryGuard(current);
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      current = path.dirname(current);
    }
  }
  return createSyncDirectoryGuard(root);
}

// Recovery receipts must retain every identity bit, including on Windows.
export async function inspectDirectoryIdentity(dir: string, expected?: Pick<BigIntStats, "dev" | "ino">): Promise<BigIntStats> {
  return inspectDirectoryIdentitySync(dir, expected);
}

function inspectDirectoryIdentitySync(
  dir: string,
  expected?: Pick<BigIntStats, "dev" | "ino">,
): BigIntStats {
  const operationPath = pathForWindowsFilesystem(dir);
  return inspectFileIdentitySync(() => {
    const stat = fsSync.lstatSync(operationPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
    return stat;
  }, expected);
}
