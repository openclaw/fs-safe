import type { BigIntStats, Dir, Stats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  assertAsyncDirectoryGuard,
  assertDirectoryObservationGuardSync,
  assertDirectoryObservationSync,
  createAsyncDirectoryGuard,
  extendDirectoryObservationGuard,
  type AsyncDirectoryGuard,
  type DirectoryObservationGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import {
  inspectNativeDirectoryObservation,
  isNativeDirectoryObservationGuard,
  type NativeDirectoryObservationBackend,
} from "./native-directory-observation.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { rootPathChangedError } from "./root-errors.js";
import type {
  RootPathDirectoryObservationGuard,
  RootPathObservationReceipt,
  RootPathParentObservationReceipt,
} from "./root-path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { createSuppressedError } from "./suppressed-error.js";
import { realpathSync } from "./realpath.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import type { DirEntry, PathStat } from "./types.js";

const METADATA_BATCH_SIZE = 32;

export function pathStatFromStats(stat: Stats | BigIntStats): PathStat {
  const mtimeMs = typeof stat.mtimeMs === "bigint"
    ? "mtimeNs" in stat && typeof stat.mtimeNs === "bigint"
      ? Number(stat.mtimeNs) / 1_000_000
      : stat.mtime.getTime()
    : stat.mtimeMs;
  return {
    dev: Number(stat.dev),
    gid: Number(stat.gid),
    ino: Number(stat.ino),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    mode: Number(stat.mode),
    mtimeMs,
    nlink: Number(stat.nlink),
    size: Number(stat.size),
    uid: Number(stat.uid),
  };
}

export type RootDirectoryObservationGuard = AsyncDirectoryGuard<BigIntStats>;

export async function createRootDirectoryObservationGuard(
  root: RootContext,
  directory: string,
): Promise<RootDirectoryObservationGuard> {
  const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
  const admittedRealPath = admitPathInsideRoot({
    rootPath: root.rootReal,
    candidatePath: guard.realPath,
    rootIdentity: root.rootIdentity,
  });
  if (!admittedRealPath) {
    throw new FsSafeError("outside-workspace", "directory is outside workspace root");
  }
  guard.dir = admittedRealPath.path;
  guard.realPath = admittedRealPath.path;
  return guard;
}

function directoryChangedError(error: unknown): FsSafeError {
  if (error instanceof FsSafeError && error.code === "path-mismatch") return error;
  return new FsSafeError("path-mismatch", "directory changed during operation", {
    cause: error instanceof Error ? error : undefined,
  });
}

export async function assertRootDirectoryObservationGuard(
  root: RootContext,
  guard: RootDirectoryObservationGuard | RootPathDirectoryObservationGuard,
): Promise<void> {
  if (isNativeDirectoryObservationGuard(guard)) {
    throw new FsSafeError("path-mismatch", "native directory observation cannot be revalidated");
  }
  const identity = "identity" in guard ? guard.identity : guard.stat;
  const guardPinsRoot = guard.dir === root.rootReal &&
    identity.dev === root.rootIdentity.dev && identity.ino === root.rootIdentity.ino;
  if (guardPinsRoot) {
    try {
      if ("identity" in guard) assertDirectoryObservationGuardSync(guard);
      else await assertAsyncDirectoryGuard(guard);
    } catch (error) {
      throw rootPathChangedError(error instanceof Error ? error : undefined);
    }
    return;
  }
  if ("identity" in guard && typeof root.rootIdentity.dev === "bigint" &&
    typeof root.rootIdentity.ino === "bigint") {
    try {
      assertDirectoryObservationSync(root.rootReal, root.rootIdentity as { dev: bigint; ino: bigint });
    } catch (error) {
      throw rootPathChangedError(error instanceof Error ? error : undefined);
    }
  } else {
    await assertRootIdentityCurrent(root);
  }
  try {
    if ("identity" in guard) assertDirectoryObservationGuardSync(guard);
    else await assertAsyncDirectoryGuard(guard);
  } catch (error) {
    throw directoryChangedError(error);
  }
}

function sameObservationDirectory(
  left: RootPathDirectoryObservationGuard,
  right: RootPathDirectoryObservationGuard,
): boolean {
  return left.dir === right.dir && left.realPath === right.realPath &&
    left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino;
}

function assertReceiptDirectoryGuardSync(
  root: RootContext,
  guard: RootPathDirectoryObservationGuard,
  backend: NativeDirectoryObservationBackend | undefined,
): void {
  if (backend) {
    const observed = inspectNativeDirectoryObservation(backend, guard.dir, guard.identity);
    const admitted = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: observed.realPath,
      rootIdentity: root.rootIdentity,
    });
    if (!admitted || admitted.path !== guard.realPath) {
      throw new FsSafeError("path-mismatch", "directory changed during operation");
    }
    return;
  }
  if (isNativeDirectoryObservationGuard(guard)) {
    throw new FsSafeError("path-mismatch", "native directory observation cannot be revalidated");
  }
  assertDirectoryObservationGuardSync(guard);
}

/**
 * Close an operation-local traversal receipt with fresh exact observations.
 * Descendant canonical paths are admitted while the receipt is created. The
 * final directory check repeats canonical admission; the Root-only case does
 * both its identity and canonical check here.
 */
export function assertRootPathObservationReceiptCurrent(
  root: RootContext,
  receipt: RootPathObservationReceipt | RootPathParentObservationReceipt,
  finalTarget?: Stats | BigIntStats,
): void {
  const { rootGuard, directoryGuard } = receipt;
  if (rootGuard.dir !== root.rootReal || rootGuard.realPath !== root.rootReal ||
    rootGuard.identity.dev !== root.rootIdentity.dev || rootGuard.identity.ino !== root.rootIdentity.ino) {
    throw rootPathChangedError();
  }
  if (sameObservationDirectory(rootGuard, directoryGuard)) {
    try {
      if (receipt.kind === "stat" && receipt.target === rootGuard && finalTarget &&
        !receipt.directoryObserver) {
        if (finalTarget.isSymbolicLink() || !finalTarget.isDirectory() ||
          realpathSync.native(rootGuard.dir) !== rootGuard.realPath) {
          throw new FsSafeError("path-mismatch", "root path changed during operation");
        }
      } else {
        assertReceiptDirectoryGuardSync(root, directoryGuard, receipt.directoryObserver);
      }
    } catch (error) {
      throw rootPathChangedError(error instanceof Error ? error : undefined);
    }
    return;
  }
  try {
    assertDirectoryObservationSync(rootGuard.dir, rootGuard.identity);
  } catch (error) {
    throw rootPathChangedError(error instanceof Error ? error : undefined);
  }
  try {
    assertReceiptDirectoryGuardSync(root, directoryGuard, receipt.directoryObserver);
  } catch (error) {
    throw directoryChangedError(error);
  }
}

function normalizeDirectoryError(error: unknown): unknown {
  if (isNotFoundPathError(error)) {
    return new FsSafeError("not-found", "directory not found", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

function normalizeInitialDirectoryError(error: unknown): unknown {
  if (error instanceof FsSafeError && error.code === "not-file") {
    return new FsSafeError("not-found", "directory not found", { cause: error });
  }
  return normalizeDirectoryError(error);
}

export function listDirectoryPath(
  root: RootContext,
  directory: string,
  withFileTypes: true,
  receipt?: RootPathObservationReceipt,
): Promise<DirEntry[]>;
export function listDirectoryPath(
  root: RootContext,
  directory: string,
  withFileTypes: boolean,
  receipt?: RootPathObservationReceipt,
): Promise<string[] | DirEntry[]>;
export async function listDirectoryPath(
  root: RootContext,
  directory: string,
  withFileTypes: boolean,
  receipt?: RootPathObservationReceipt,
): Promise<string[] | DirEntry[]> {
  let guard: RootDirectoryObservationGuard | RootPathDirectoryObservationGuard;
  if (receipt) {
    if (receipt.kind !== "directory" || receipt.targetPath !== directory ||
      receipt.directoryGuard.dir !== directory ||
      receipt.target !== receipt.directoryGuard ||
      (!isNativeDirectoryObservationGuard(receipt.directoryGuard) &&
        !receipt.directoryGuard.stat.isDirectory())) {
      throw new FsSafeError("path-mismatch", "directory observation receipt does not match target");
    }
    guard = receipt.directoryGuard;
  } else {
    try {
      guard = await createRootDirectoryObservationGuard(root, directory);
    } catch (error) {
      throw normalizeInitialDirectoryError(error);
    }
  }
  return await listGuardedDirectoryPath(root, guard, withFileTypes, receipt);
}

function listGuardedDirectoryPath(
  root: RootContext,
  guard: RootDirectoryObservationGuard | RootPathDirectoryObservationGuard,
  withFileTypes: true,
  receipt?: RootPathObservationReceipt,
): Promise<DirEntry[]>;
function listGuardedDirectoryPath(
  root: RootContext,
  guard: RootDirectoryObservationGuard | RootPathDirectoryObservationGuard,
  withFileTypes: boolean,
  receipt?: RootPathObservationReceipt,
): Promise<string[] | DirEntry[]>;
async function listGuardedDirectoryPath(
  root: RootContext,
  guard: RootDirectoryObservationGuard | RootPathDirectoryObservationGuard,
  withFileTypes: boolean,
  receipt?: RootPathObservationReceipt,
): Promise<string[] | DirEntry[]> {
  let entries: string[] | DirEntry[];
  try {
    const beforeObservation = getFsSafeTestHooks()?.beforeRootListObservation;
    if (beforeObservation) await beforeObservation(guard.realPath, withFileTypes);
    const names = (await fs.readdir(guard.realPath)).sort();
    entries = withFileTypes
      ? names.map(name => ({
        name,
        ...pathStatFromStats(fsSync.lstatSync(path.join(guard.realPath, name))),
      }))
      : names;
  } catch (error) {
    // Preserve ordinary observation errors only while the admitted directory is
    // still current. A post-admission replacement is an identity failure.
    if (receipt) assertRootPathObservationReceiptCurrent(root, receipt);
    else await assertRootDirectoryObservationGuard(root, guard);
    throw normalizeDirectoryError(error);
  }
  if (receipt) assertRootPathObservationReceiptCurrent(root, receipt);
  else await assertRootDirectoryObservationGuard(root, guard);
  return entries;
}

export type RootDirectoryListing = {
  assertCurrent(): Promise<void>;
  next(): Promise<{ kind: "entry"; entry: DirEntry } | { kind: "limit"; name: string } | undefined>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type RootDirectoryListingOptions = {
  order: "sorted" | "filesystem";
  signal?: AbortSignal;
  snapshot: boolean;
  maxNames?: number;
  metadataBatchSize?: number;
  admitEntry(): boolean;
};

export async function openRootDirectoryListing(
  root: RootContext,
  directory: string,
  options: RootDirectoryListingOptions,
): Promise<RootDirectoryListing> {
  const admitted = await createRootDirectoryObservationGuard(root, directory).catch((error) => {
    throw normalizeDirectoryError(error);
  });
  // Retain exact admission identities; metadata rechecks can use numeric Stats
  // only when every identity component is losslessly representable.
  const guard = extendDirectoryObservationGuard({
    stat: admitted.stat,
    identity: { dev: admitted.stat.dev, ino: admitted.stat.ino },
  }, admitted.dir, admitted.realPath);
  const assertCurrent = async () => {
    options.signal?.throwIfAborted();
    await assertRootDirectoryObservationGuard(root, guard);
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
      snapshot = await listGuardedDirectoryPath(root, guard, true);
    } else if (options.maxNames !== undefined) {
      names = [];
      handle = await fs.opendir(guard.realPath, { bufferSize: 1 });
      while (true) {
        await assertCurrent();
        const name = (await handle.read())?.name;
        await assertCurrent();
        if (name === undefined) break;
        if (names.length >= options.maxNames) {
          throw new FsSafeError("too-large", "directory entry budget exceeded");
        }
        names.push(name);
      }
      await close();
    } else {
      names = await fs.readdir(guard.realPath);
    }
    await assertCurrent();
    names?.sort();
  } catch (error) {
    const operationError = normalizeDirectoryError(error);
    try {
      await close();
    } catch (closeError) {
      throw createSuppressedError(closeError, operationError, "directory setup and close both failed");
    }
    throw operationError;
  }

  const prepareBatch = async (sortedNames: readonly string[]) => {
    let name = sortedNames[index++];
    if (name === undefined) {
      await assertCurrent();
      return;
    }
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
        if (entry.isDirectory || entry.isSymbolicLink || prepared.length >= (options.metadataBatchSize ?? METADATA_BATCH_SIZE)) break;
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
    assertCurrent,
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
