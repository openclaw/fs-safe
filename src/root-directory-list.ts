import type { Dir, Stats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { rootPathChangedError } from "./root-errors.js";
import { createSuppressedError } from "./suppressed-error.js";
import type { DirEntry, PathStat } from "./types.js";

const METADATA_BATCH_SIZE = 32;

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

function normalizeDirectoryError(error: unknown): unknown {
  if (isNotFoundPathError(error)) {
    return new FsSafeError("not-found", "directory not found", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

export function listDirectoryPath(root: RootContext, directory: string, withFileTypes: true): Promise<DirEntry[]>;
export function listDirectoryPath(root: RootContext, directory: string, withFileTypes: boolean): Promise<string[] | DirEntry[]>;
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
    throw normalizeDirectoryError(error);
  }
}

export type RootDirectoryListing = {
  next(): Promise<{ kind: "entry"; entry: DirEntry } | { kind: "limit"; name: string } | undefined>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type RootDirectoryListingOptions = {
  order: "sorted" | "filesystem";
  signal?: AbortSignal;
  snapshot: boolean;
  admitEntry(): boolean;
};

export async function listDirectoryForWalk(
  root: RootContext,
  directory: string,
  options: RootDirectoryListingOptions,
): Promise<RootDirectoryListing> {
  const guard = await createAsyncDirectoryGuard(directory, { bigint: true }).catch((error) => {
    throw normalizeDirectoryError(error);
  });
  if (!isPathInside(root.rootReal, guard.realPath)) {
    throw new FsSafeError("outside-workspace", "directory is outside workspace root");
  }
  const guardPinsRoot = guard.dir === root.rootReal &&
    guard.stat.dev === root.rootIdentity.dev && guard.stat.ino === root.rootIdentity.ino;
  const assertCurrent = async () => {
    options.signal?.throwIfAborted();
    if (guardPinsRoot) {
      // One exact receipt proves both identities without dropping the canonical-path check.
      try {
        await assertAsyncDirectoryGuard(guard);
      } catch (error) {
        throw rootPathChangedError(error instanceof Error ? error : undefined);
      }
    } else {
      await assertRootIdentityCurrent(root);
      await assertAsyncDirectoryGuard(guard);
    }
    options.signal?.throwIfAborted();
  };
  let handle: Dir | undefined;
  let names: string[] | undefined;
  let snapshot: DirEntry[] | undefined;
  let index = 0;
  let prepared: DirEntry[] = [];
  let preparedIndex = 0;
  let pendingFailure: { error: unknown } | undefined;
  let pendingLimit: string | undefined;
  let preparedBatch = false;
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
    } else if (options.snapshot) {
      snapshot = await listDirectoryPath(root, guard.realPath, true);
    } else {
      names = await fs.readdir(guard.realPath);
    }
    await assertCurrent();
    names?.sort();
  } catch (error) {
    await using cleanup = { [Symbol.asyncDispose]: close };
    throw normalizeDirectoryError(error);
  }

  const prepareBatch = async (sortedNames: readonly string[]) => {
    let name = sortedNames[index++];
    if (name === undefined) return;
    if (!options.admitEntry()) {
      pendingLimit = name;
      return;
    }
    if (preparedBatch) await yieldToEventLoop();
    await assertCurrent();
    preparedBatch = true;
    prepared = [];
    preparedIndex = 0;
    while (true) {
      try {
        const entry = { name, ...pathStatFromStats(fsSync.lstatSync(path.join(guard.realPath, name))) };
        prepared.push(entry);
        // No later sibling can be observed before a possible recursive descent.
        if (entry.isDirectory || entry.isSymbolicLink || prepared.length >= METADATA_BATCH_SIZE) break;
      } catch (error) {
        pendingFailure = { error: normalizeDirectoryError(error) };
        break;
      }
      name = sortedNames[index++];
      if (name === undefined) break;
      if (!options.admitEntry()) {
        pendingLimit = name;
        break;
      }
    }
    try {
      await assertCurrent();
    } catch (error) {
      if (pendingFailure) {
        throw createSuppressedError(error, pendingFailure.error, "directory observation and identity checks both failed");
      }
      throw error;
    }
  };

  return {
    async next() {
      try {
        options.signal?.throwIfAborted();
        if (snapshot) {
          const entry = snapshot[index++];
          if (!entry) return;
          return options.admitEntry() ? { kind: "entry", entry } : { kind: "limit", name: entry.name };
        }
        if (names) {
          if (preparedIndex >= prepared.length && !pendingFailure && pendingLimit === undefined) {
            await prepareBatch(names);
          }
          const entry = prepared[preparedIndex++];
          if (entry) return { kind: "entry", entry };
          if (pendingFailure) throw pendingFailure.error;
          if (pendingLimit !== undefined) return { kind: "limit", name: pendingLimit };
          return;
        }
        await assertCurrent();
        const name = (await handle!.read())?.name;
        await assertCurrent();
        if (name === undefined) return;
        if (!options.admitEntry()) return { kind: "limit", name };
        // The stream's post-read fence is also the pre-stat fence in this owned operation.
        const stat = fsSync.lstatSync(path.join(guard.realPath, name));
        await assertCurrent();
        return { kind: "entry", entry: { name, ...pathStatFromStats(stat) } };
      } catch (error) {
        throw normalizeDirectoryError(error);
      }
    },
    [Symbol.asyncDispose]: close,
  };
}
