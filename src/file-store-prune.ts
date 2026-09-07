import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export type FileStorePruneOptions = {
  ttlMs: number;
  recursive?: boolean;
  maxDepth?: number;
  pruneEmptyDirs?: boolean;
};

export async function pruneExpiredStoreEntries(params: {
  rootDir: string;
  dirMode: number;
  options: FileStorePruneOptions;
}): Promise<void> {
  const now = Date.now();
  const recursive = params.options.recursive ?? false;
  const maxDepth = params.options.maxDepth;
  const pruneEmptyDirs =
    (recursive || maxDepth !== undefined) && (params.options.pruneEmptyDirs ?? false);
  await fs.mkdir(params.rootDir, { recursive: true, mode: params.dirMode });
  const rootReal = fsSync.realpathSync(params.rootDir);
  const scopedRoot = await root(rootReal);
  const rootGuard = {
    dir: rootReal,
    realPath: rootReal,
    stat: fsSync.lstatSync(rootReal),
  };

  async function assertRootGuard(): Promise<void> {
    const stat = fsSync.lstatSync(rootGuard.dir);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== rootGuard.stat.dev ||
      stat.ino !== rootGuard.stat.ino ||
      fsSync.realpathSync(rootGuard.dir) !== rootGuard.realPath
    ) {
      throw new FsSafeError("path-mismatch", "store root changed during prune");
    }
  }

  async function readStableDirectory(dir: string): Promise<Dirent[] | null> {
    const before = observeOrNull(() => fsSync.lstatSync(dir));
    if (!before || before.isSymbolicLink() || !before.isDirectory()) {
      return null;
    }
    const real = observeOrNull(() => fsSync.realpathSync(dir));
    if (!real || !isPathInside(rootReal, real)) {
      return null;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return null;
    }
    const after = observeOrNull(() => fsSync.lstatSync(dir));
    if (!after || before.dev !== after.dev || before.ino !== after.ino) {
      return null;
    }
    return entries;
  }

  async function pruneDir(dir: string, relativeDir: string, depth: number): Promise<boolean> {
    const entries = await readStableDirectory(dir);
    if (!entries) {
      return false;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const stat = observeOrNull(() => fsSync.lstatSync(fullPath));
      if (!stat || stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        const shouldDescend = maxDepth !== undefined ? depth < maxDepth : recursive;
        if (shouldDescend) {
          await getFsSafeTestHooks()?.beforeFileStorePruneDescend?.(fullPath);
        }
        if (shouldDescend && (await pruneDir(fullPath, relativePath, depth + 1))) {
          await assertRootGuard();
          // Keep empty-dir pruning on the same root-bounded remove path as files;
          // the Root fallback handles empty directories without recursive delete.
          await scopedRoot.remove(relativePath).catch(() => undefined);
        }
        continue;
      }
      if (stat.isFile() && now - stat.mtimeMs > params.options.ttlMs) {
        await assertRootGuard();
        await scopedRoot.remove(relativePath).catch(() => undefined);
      }
    }
    if (!pruneEmptyDirs) {
      return false;
    }
    const remaining = await readStableDirectory(dir);
    return remaining !== null && remaining.length === 0;
  }

  await pruneDir(rootReal, "", 0);
}

function observeOrNull<T>(observe: () => T): T | null {
  try { return observe(); } catch { return null; }
}
