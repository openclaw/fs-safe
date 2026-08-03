import type { Stats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";

export type AsyncDirectoryGuard = {
  dir: string;
  realPath: string;
  stat: Stats;
};

export type SyncDirectoryGuard = {
  dir: string;
  realPath: string;
  stat: Stats;
};

export async function createAsyncDirectoryGuard(dir: string): Promise<AsyncDirectoryGuard> {
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  return { dir, realPath: await fs.realpath(dir), stat };
}

export async function assertAsyncDirectoryGuard(guard: AsyncDirectoryGuard): Promise<void> {
  const stat = await fs.lstat(guard.dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  if (!sameFileIdentity(stat, guard.stat) || (await fs.realpath(guard.dir)) !== guard.realPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export function createSyncDirectoryGuard(dir: string): SyncDirectoryGuard {
  const stat = fsSync.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  return { dir, realPath: fsSync.realpathSync(dir), stat };
}

export function assertSyncDirectoryGuard(guard: SyncDirectoryGuard): void {
  const stat = fsSync.lstatSync(guard.dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw directoryComponentNotDirectoryError();
  }
  if (!sameFileIdentity(stat, guard.stat) || fsSync.realpathSync(guard.dir) !== guard.realPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export async function createNearestExistingDirectoryGuard(
  rootReal: string,
  targetPath: string,
): Promise<AsyncDirectoryGuard> {
  let current = path.resolve(targetPath);
  const root = path.resolve(rootReal);
  while (current !== root) {
    try {
      return await createAsyncDirectoryGuard(current);
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      current = path.dirname(current);
    }
  }
  return await createAsyncDirectoryGuard(root);
}

export function createNearestExistingSyncDirectoryGuard(
  rootReal: string,
  targetPath: string,
): SyncDirectoryGuard {
  let current = path.resolve(targetPath);
  const root = path.resolve(rootReal);
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
