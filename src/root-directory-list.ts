import type { Dir, Stats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import type { DirEntry, PathStat } from "./types.js";

export function pathStatFromStats(stat: Stats): PathStat {
  return {
    dev: Number(stat.dev),
    gid: Number(stat.gid),
    ino: Number(stat.ino),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
  };
}

function normalizeDirectoryError(error: unknown): never {
  if (isNotFoundPathError(error)) {
    throw new FsSafeError("not-found", "directory not found", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  throw error;
}

export async function listDirectoryPath(
  root: RootContext,
  directory: string,
  withFileTypes: boolean,
): Promise<string[] | DirEntry[]> {
  try {
    const names = (await fs.readdir(directory)).sort();
    const entries = withFileTypes
      ? names.map(name => ({
        name,
        ...pathStatFromStats(fsSync.lstatSync(path.join(directory, name))),
      }))
      : names;
    await assertRootIdentityCurrent(root);
    return entries;
  } catch (error) {
    normalizeDirectoryError(error);
  }
}

export type RootDirectoryListing = {
  next(): Promise<string | undefined>;
  readEntry(name: string): Promise<DirEntry>;
  close(): Promise<void>;
};

export async function listDirectoryForWalk(
  root: RootContext,
  directory: string,
  options: { order: "sorted" | "filesystem"; signal?: AbortSignal },
): Promise<RootDirectoryListing> {
  const guard = await createAsyncDirectoryGuard(directory, { bigint: true }).catch(normalizeDirectoryError);
  if (!isPathInside(root.rootReal, guard.realPath)) {
    throw new FsSafeError("outside-workspace", "directory is outside workspace root");
  }
  const assertCurrent = async () => {
    options.signal?.throwIfAborted();
    await assertRootIdentityCurrent(root);
    await assertAsyncDirectoryGuard(guard);
    options.signal?.throwIfAborted();
  };
  let handle: Dir | undefined;
  let names: string[] | undefined;
  let index = 0;
  const close = async () => {
    const owned = handle;
    handle = undefined;
    await owned?.close();
  };
  try {
    await assertCurrent();
    if (options.order === "filesystem") {
      // A one-entry buffer keeps the truncation lookahead independent of width.
      handle = await fs.opendir(guard.realPath, { bufferSize: 1 });
    } else {
      names = await fs.readdir(guard.realPath);
    }
    await assertCurrent();
    names?.sort();
  } catch (error) {
    await close();
    normalizeDirectoryError(error);
  }
  return {
    async next() {
      options.signal?.throwIfAborted();
      if (names) return names[index++];
      await assertCurrent();
      const entry = await handle!.read();
      await assertCurrent();
      return entry?.name;
    },
    async readEntry(name) {
      try {
        // Iteration yields to the caller, so pathname metadata needs a fresh fence.
        await assertCurrent();
        const stat = await fs.lstat(path.join(guard.realPath, name));
        await assertCurrent();
        return { name, ...pathStatFromStats(stat) };
      } catch (error) {
        normalizeDirectoryError(error);
      }
    },
    close,
  };
}
