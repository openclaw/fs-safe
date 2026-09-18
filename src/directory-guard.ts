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
import { directoryEntryPath } from "./directory-entry-path.js";
import {
  assertStatObservationSync,
  inspectStatObservationSync,
  type ExactStatIdentity,
  type StatObservationReceipt,
} from "./stat-observation.js";

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

export function createAsyncDirectoryGuard(dir: string, options: { bigint: true; initial?: BigIntStats }): Promise<AsyncDirectoryGuard<BigIntStats>>;
export function createAsyncDirectoryGuard(dir: string, options?: { bigint?: false }): Promise<AsyncDirectoryGuard>;
export function createAsyncDirectoryGuard(dir: string, options: { bigint: boolean }): Promise<AnyAsyncDirectoryGuard>;
export async function createAsyncDirectoryGuard(dir: string, options?: { bigint?: boolean; initial?: BigIntStats }): Promise<AnyAsyncDirectoryGuard> {
  const operationPath = directoryOperationPath(dir);
  const stat = options?.bigint
    ? inspectDirectoryIdentityAtPathSync(operationPath, undefined, options.initial)
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
export function createNearestExistingDirectoryGuard(rootReal: string, targetPath: string, options: { bigint: true }): Promise<AsyncDirectoryGuard<BigIntStats>>;
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

function directoryOperationPath(dir: string): string {
  assertNoWindowsPathAlias(dir, "filesystem");
  return pathForWindowsFilesystem(directoryEntryPath(dir));
}

export function observeDirectoryIdentitySync(
  dir: string,
  options: { bigint: true },
): BigIntStats;
export function observeDirectoryIdentitySync(
  dir: string,
  options?: { bigint?: false },
): Stats;
export function observeDirectoryIdentitySync(
  dir: string,
  options?: { bigint?: boolean },
): Stats | BigIntStats {
  const entryPath = directoryOperationPath(dir);
  const stat = options?.bigint
    ? fsSync.lstatSync(entryPath, { bigint: true })
    : fsSync.lstatSync(entryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
  return stat;
}

export function inspectDirectoryIdentitySync(
  dir: string,
  expected?: Pick<BigIntStats, "dev" | "ino">,
  initial?: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): BigIntStats {
  const operationPath = directoryOperationPath(dir);
  const expectedIdentity = expected === undefined
    ? undefined
    : { dev: expected.dev, ino: expected.ino };
  return inspectDirectoryIdentityAtPathSync(operationPath, expectedIdentity, initial, platform);
}

function inspectDirectoryIdentityAtPathSync(
  operationPath: string,
  expected?: Pick<BigIntStats, "dev" | "ino">,
  initial?: BigIntStats,
  platform: NodeJS.Platform = process.platform,
): BigIntStats {
  return inspectFileIdentitySync(() => {
    // Traversal can supply the first exact observation. A bounded retry still
    // uses the admitted operation path and retains every known identity bit.
    const stat = initial ?? fsSync.lstatSync(operationPath, { bigint: true });
    initial = undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
    return stat;
  }, expected, platform);
}

export type DirectoryObservationGuard = StatObservationReceipt & { dir: string; realPath: string };

export function extendDirectoryObservationGuard(
  observation: StatObservationReceipt,
  dir: string,
  realPath: string,
): DirectoryObservationGuard {
  const guard = observation as DirectoryObservationGuard;
  guard.dir = dir;
  guard.realPath = realPath;
  return guard;
}

// Only stat/list receipts use this metadata fast path. Recovery and publication
// callers retain the BigIntStats contract of inspectDirectoryIdentitySync.
export function inspectDirectoryObservationSync(
  dir: string,
  expected?: ExactStatIdentity,
): StatObservationReceipt {
  const entryPath = directoryOperationPath(dir);
  return inspectStatObservationSync(bigint => {
    const stat = bigint ? fsSync.lstatSync(entryPath, { bigint: true }) : fsSync.lstatSync(entryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
    return stat;
  }, expected);
}

export function assertDirectoryObservationSync(
  dir: string,
  expected: ExactStatIdentity,
): Stats | BigIntStats {
  const entryPath = directoryOperationPath(dir);
  return assertStatObservationSync(bigint => {
    const stat = bigint ? fsSync.lstatSync(entryPath, { bigint: true }) : fsSync.lstatSync(entryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
    return stat;
  }, expected);
}

export function assertDirectoryObservationGuardSync(guard: DirectoryObservationGuard): void {
  const dir = guard.dir;
  const expectedRealPath = guard.realPath;
  assertNoWindowsPathAlias(expectedRealPath, "filesystem");
  assertDirectoryObservationSync(dir, guard.identity);
  const realPath = realpathSync.native(directoryOperationPath(dir));
  assertNoWindowsPathAlias(realPath, "filesystem");
  if (realPath !== expectedRealPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}
