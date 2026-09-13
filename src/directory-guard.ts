import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";

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
  assertNoWindowsPathAlias(dir, "filesystem");
  const operationPath = pathForWindowsFilesystem(dir);
  const stat = options?.bigint
    ? inspectDirectoryIdentitySync(operationPath)
    : fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  const realPath = realpathSync.native(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem");
  return { dir, realPath, stat };
}

export async function assertAsyncDirectoryGuard(guard: AnyAsyncDirectoryGuard): Promise<void> {
  const dir = guard.dir;
  assertNoWindowsPathAlias(dir, "filesystem");
  const expectedRealPath = guard.realPath;
  assertNoWindowsPathAlias(expectedRealPath, "filesystem");
  const expectedStat = guard.stat;
  const expectedIdentity = { dev: expectedStat.dev, ino: expectedStat.ino };
  const operationPath = pathForWindowsFilesystem(dir);
  const stat = typeof expectedIdentity.dev === "bigint" && typeof expectedIdentity.ino === "bigint"
    ? inspectDirectoryIdentitySync(operationPath, {
      dev: expectedIdentity.dev,
      ino: expectedIdentity.ino,
    })
    : fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  if (!sameFileIdentity(stat, expectedIdentity)) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
  const realPath = realpathSync.native(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem");
  if (realPath !== expectedRealPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export function createSyncDirectoryGuard(dir: string): SyncDirectoryGuard {
  assertNoWindowsPathAlias(dir, "filesystem");
  const operationPath = pathForWindowsFilesystem(dir);
  const stat = fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  const realPath = realpathSync(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem");
  return { dir, realPath, stat };
}

export function assertSyncDirectoryGuard(guard: SyncDirectoryGuard | AnyAsyncDirectoryGuard): void {
  const dir = guard.dir;
  assertNoWindowsPathAlias(dir, "filesystem");
  const expectedRealPath = guard.realPath;
  assertNoWindowsPathAlias(expectedRealPath, "filesystem");
  const expectedStat = guard.stat;
  const expectedIdentity = { dev: expectedStat.dev, ino: expectedStat.ino };
  const operationPath = pathForWindowsFilesystem(dir);
  const stat = typeof expectedIdentity.dev === "bigint" && typeof expectedIdentity.ino === "bigint"
    ? inspectFileIdentitySync(
      () => fsSync.lstatSync(operationPath, { bigint: true }),
      { dev: expectedIdentity.dev, ino: expectedIdentity.ino },
    )
    : fsSync.lstatSync(operationPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  const realPath = typeof expectedIdentity.ino === "bigint"
    ? realpathSync.native(operationPath) : realpathSync(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem");
  if (!sameFileIdentity(stat, expectedIdentity) || realPath !== expectedRealPath) {
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
  assertNoWindowsPathAlias(rootReal, "filesystem");
  assertNoWindowsPathAlias(targetPath, "filesystem");
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
  assertNoWindowsPathAlias(rootReal, "filesystem");
  assertNoWindowsPathAlias(targetPath, "filesystem");
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
  assertNoWindowsPathAlias(dir, "filesystem");
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
