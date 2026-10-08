import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { ownDirectoryMode, type DirectoryModeOwner } from "./directory-mode-node.js";
import type { AtomicMutation } from "./replace-file-mutation.js";
import { inspectAtomicIdentity, wait, type AtomicFile, type AtomicIo, type Procedure } from "./atomic-io.js";

type AsyncTempFileSystem = Pick<typeof fs, "lstat" | "open">;

function parentCloseFailure(primary: { error: unknown } | undefined, closeError: unknown): unknown {
  return primary ? new AggregateError([primary.error, closeError], "Atomic parent preparation and close failed") : closeError;
}

export function* syncDirectoryBestEffort(io: AtomicIo, dirPath: string): Procedure<void> {
  let file: AtomicFile | undefined;
  try {
    file = yield* io.open(dirPath, "r");
    yield* file.sync();
  } catch {
    // Directory synchronization and close remain best-effort.
  } finally {
    try {
      const closing = file?.close();
      if (file && io.asynchronous) yield closing;
    } catch {
      // Preserve the operation's best-effort contract.
    }
  }
}

function directoryOpenFlags(): number {
  return (
    syncFs.constants.O_RDONLY |
    syncFs.constants.O_DIRECTORY |
    syncFs.constants.O_NOFOLLOW |
    syncFs.constants.O_NONBLOCK
  );
}

function assertDirectory<T extends Stats | BigIntStats>(identity: T, dirPath: string): T {
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new FsSafeError("not-file", `Atomic replace parent must be a real directory: ${dirPath}`);
  }
  return identity;
}

async function pinDirectoryForMode(params: {
  fsModule: AsyncTempFileSystem;
  dirPath: string;
  /** Compatibility for best-effort directory modes; admission and close still fail closed. */
  ignoreChmodError?: boolean;
  mutation?: AtomicMutation;
}): Promise<DirectoryModeOwner | undefined> {
  // Node does not enforce POSIX directory modes on Windows, and its directory
  // descriptors are not consistently openable. mkdir(mode) remains the only
  // bounded behavior there; never fall back to a pathname chmod.
  if (process.platform === "win32") {
    return;
  }

  const expected = params.fsModule === fs
    ? inspectFileIdentitySync(() => assertDirectory(syncFs.lstatSync(params.dirPath, { bigint: true }), params.dirPath))
    : await inspectFileIdentity(async () => assertDirectory(await params.fsModule.lstat(params.dirPath, { bigint: true }), params.dirPath));
  const handle = await params.fsModule.open(params.dirPath, directoryOpenFlags());
  try {
    const owner = ownDirectoryMode({
      async inspect() {
        const opened = params.fsModule === fs
          ? inspectFileIdentitySync(() => assertDirectory(syncFs.fstatSync(handle.fd, { bigint: true }), params.dirPath), expected)
          : await inspectFileIdentity(async () => assertDirectory(await handle.stat({ bigint: true }), params.dirPath), expected);
        return Number(opened.mode & 0o7777n);
      },
      chmod: (mode) => {
        params.mutation?.assert();
        return handle.chmod(mode);
      },
      close: () => handle.close(),
      ignoreChmodError: params.ignoreChmodError,
    });
    await owner.verify();
    return owner;
  } catch (error) {
    try { await handle.close(); }
    catch (closeError) { throw parentCloseFailure({ error }, closeError); }
    throw error;
  }
}

export function* applyDirectoryMode(io: AtomicIo, params: {
  dirPath: string;
  mode: number;
  ignoreChmodError?: boolean;
  mutation?: AtomicMutation;
}): Procedure<void> {
  if (io.asynchronous) {
    const owner = yield* wait(pinDirectoryForMode({
      ...params,
      fsModule: io.asyncFs as AsyncTempFileSystem,
    }));
    let primary: { error: unknown } | undefined;
    try {
      if (owner) yield* wait(owner.apply(params.mode));
    } catch (error) {
      primary = { error };
      throw error;
    } finally {
      try { if (owner) yield* wait(owner.close()); }
      catch (closeError) { throw parentCloseFailure(primary, closeError); }
    }
    return;
  }
  if (process.platform === "win32") return;
  const admit = (stat: BigIntStats) => assertDirectory(stat, params.dirPath);
  const expected = inspectAtomicIdentity(io, () => io.lstatExact(params.dirPath),
    undefined, false, admit) as BigIntStats;
  const file = yield* io.open(params.dirPath, directoryOpenFlags());
  let primary: { error: unknown } | undefined;
  try {
    inspectAtomicIdentity(io, () => file.statExact(), expected, false, admit);
    params.mutation?.assert();
    file.chmod(params.mode & 0o7777);
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    try { file.close(); }
    catch (closeError) { throw parentCloseFailure(primary, closeError); }
  }
}

export function* writeTempFile(io: AtomicIo, params: {
  tempPath: string;
  content: string | Uint8Array;
  mode: number;
  sync: boolean;
  onIdentity?: (identity: BigIntStats) => void;
  mutation?: AtomicMutation;
}): Procedure<{ file: AtomicFile; identity: BigIntStats }> {
  params.mutation?.assert();
  const file = yield* io.open(params.tempPath, "wx", params.mode);
  try {
    const openedInspection = inspectAtomicIdentity(io, () => file.statExact());
    const identity = (io.asynchronous ? (yield openedInspection) : openedInspection) as BigIntStats;
    params.onIdentity?.(identity);
    params.mutation?.assert();
    const writing = file.writeFile(params.content, true);
    if (io.asynchronous) yield writing;
    if (io.asyncFs === fs && process.platform !== "win32" && !params.sync) {
      // Matching non-durable writes have no I/O left after this identity fence.
      const current = inspectAtomicIdentity(io, () => file.statExact(), identity, true) as BigIntStats;
      if (Number(current.mode & 0o7777n) === (params.mode & 0o7777)) return { file, identity };
    }
    const chmod = file.chmod(params.mode);
    if (io.asynchronous) yield chmod;
    if (params.sync) yield* file.syncBestEffort();
    const currentInspection = inspectAtomicIdentity(io, () => file.statExact(), identity);
    if (io.asynchronous) yield currentInspection;
    return { file, identity };
  } catch (error) {
    try {
      const closing = file.close();
      if (io.asynchronous) yield closing;
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Atomic temp write and close failed");
    }
    throw error;
  }
}
