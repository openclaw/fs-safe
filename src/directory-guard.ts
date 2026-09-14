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

export type DirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  realPath: string;
}>;

export async function readDirectoryIdentity(dir: string): Promise<DirectoryIdentity> {
  const guard = await createAsyncDirectoryGuard(dir, { bigint: true });
  return Object.freeze({ dev: guard.stat.dev, ino: guard.stat.ino, realPath: guard.realPath });
}

export function assertDirectoryIdentitySync(
  observedPath: string,
  expected: Pick<DirectoryIdentity, "dev" | "ino"> & { realPath?: string },
): void {
  const operationPath = directoryOperationPath(observedPath);
  const expectedDev = expected.dev;
  const expectedIno = expected.ino;
  const expectedRealPath = expected.realPath;
  if (expectedRealPath !== undefined) assertNoWindowsPathAlias(expectedRealPath, "filesystem");
  inspectDirectoryIdentityAtPathSync(operationPath, { dev: expectedDev, ino: expectedIno });
  if (expectedRealPath === undefined) return;
  const realPath = realpathSync.native(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem");
  if (realPath !== expectedRealPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export function createAsyncDirectoryGuard(dir: string, options: { bigint: true }): Promise<AsyncDirectoryGuard<BigIntStats>>;
export function createAsyncDirectoryGuard(dir: string, options?: { bigint?: false }): Promise<AsyncDirectoryGuard>;
export function createAsyncDirectoryGuard(dir: string, options: { bigint: boolean }): Promise<AnyAsyncDirectoryGuard>;
export async function createAsyncDirectoryGuard(dir: string, options?: { bigint?: boolean }): Promise<AnyAsyncDirectoryGuard> {
  const operationPath = directoryOperationPath(dir);
  const stat = options?.bigint
    ? inspectDirectoryIdentityAtPathSync(operationPath)
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
  const operationPath = directoryOperationPath(dir);
  const expectedRealPath = guard.realPath;
  assertNoWindowsPathAlias(expectedRealPath, "filesystem");
  const expectedStat = guard.stat;
  const expectedIdentity = { dev: expectedStat.dev, ino: expectedStat.ino };
  const stat = typeof expectedIdentity.dev === "bigint" && typeof expectedIdentity.ino === "bigint"
    ? inspectDirectoryIdentityAtPathSync(operationPath, {
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
  const operationPath = directoryOperationPath(dir);
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
  const operationPath = directoryOperationPath(dir);
  const expectedRealPath = guard.realPath;
  assertNoWindowsPathAlias(expectedRealPath, "filesystem");
  const expectedStat = guard.stat;
  const expectedIdentity = { dev: expectedStat.dev, ino: expectedStat.ino };
  const stat = typeof expectedIdentity.dev === "bigint" && typeof expectedIdentity.ino === "bigint"
    ? inspectDirectoryIdentityAtPathSync(
      operationPath,
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
  const operationPath = directoryOperationPath(dir);
  const expectedIdentity = expected === undefined
    ? undefined
    : { dev: expected.dev, ino: expected.ino };
  return inspectDirectoryIdentityAtPathSync(operationPath, expectedIdentity);
}

function directoryEntryPath(dir: string): string {
  const windows = process.platform === "win32";
  if (typeof dir === "string") {
    const last = dir[dir.length - 1];
    if (last !== "/" && (!windows || last !== "\\")) return dir;
  }
  let rootLength = (windows ? path.win32 : path.posix).parse(dir).root.length;
  if (windows && /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(dir)) {
    // Node parses the namespace prefix as the root; retain the complete UNC share instead.
    const uncRoot = path.win32.parse(`\\\\${dir.slice(8)}`).root;
    if (uncRoot.length > 1) rootLength = Math.max(rootLength, uncRoot.length + 6);
  }
  let end = dir.length;
  while (end > rootLength && (dir[end - 1] === "/" || (windows && dir[end - 1] === "\\"))) end--;
  return end === rootLength || end === dir.length ? dir : dir.slice(0, end);
}

function directoryOperationPath(dir: string): string {
  assertNoWindowsPathAlias(dir, "filesystem");
  return pathForWindowsFilesystem(directoryEntryPath(dir));
}

export function inspectDirectoryIdentitySync(
  dir: string,
  expected?: Pick<BigIntStats, "dev" | "ino">,
): BigIntStats {
  const operationPath = directoryOperationPath(dir);
  const expectedIdentity = expected === undefined
    ? undefined
    : { dev: expected.dev, ino: expected.ino };
  return inspectDirectoryIdentityAtPathSync(operationPath, expectedIdentity);
}

function inspectDirectoryIdentityAtPathSync(
  operationPath: string,
  expected?: Pick<BigIntStats, "dev" | "ino">,
): BigIntStats {
  return inspectFileIdentitySync(() => {
    const stat = fsSync.lstatSync(operationPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
    return stat;
  }, expected);
}
