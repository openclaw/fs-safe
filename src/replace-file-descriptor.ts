import { syncFileBestEffort, syncFileBestEffortSync } from "./file-sync.js";
import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { ownDirectoryMode, type DirectoryModeOwner } from "./directory-mode-node.js";
import type { AtomicMutation } from "./replace-file-mutation.js";

type AsyncTempFileSystem = Pick<typeof fs, "lstat" | "open" | "writeFile">;
type SyncTempFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "fsyncSync" | "lstatSync" | "openSync" | "writeFileSync"
>;

export type SyncFchmod = (fd: number, mode: number) => void;

export async function syncDirectoryBestEffort(
  fsModule: Pick<typeof fs, "open">,
  dirPath: string,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsModule.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    try {
      await handle?.close();
    } catch {
      // Best-effort close also covers synchronous adapter throws.
    }
  }
}

export function syncDirectoryBestEffortSync(
  fsModule: Pick<typeof syncFs, "openSync" | "fsyncSync" | "closeSync">,
  dirPath: string,
): void {
  let fd: number | undefined;
  try {
    fd = fsModule.openSync(dirPath, "r");
    fsModule.fsyncSync(fd);
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    if (fd !== undefined) {
      try {
        fsModule.closeSync(fd);
      } catch {
        // Best-effort close after directory fsync.
      }
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

export async function pinDirectoryForMode(params: {
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
    await handle.close();
    throw error;
  }
}

export async function applyDirectoryMode(params: Parameters<typeof pinDirectoryForMode>[0] & {
  mode: number;
}): Promise<void> {
  const owner = await pinDirectoryForMode(params);
  try {
    await owner?.apply(params.mode);
  } finally {
    await owner?.close();
  }
}

export function applyDirectoryModeSync(params: {
  fsModule: SyncTempFileSystem;
  dirPath: string;
  mode: number;
  fchmodSync?: SyncFchmod;
  mutation?: AtomicMutation;
}): void {
  if (process.platform === "win32") {
    return;
  }

  const expected = inspectFileIdentitySync(() => assertDirectory(params.fsModule.lstatSync(params.dirPath, { bigint: true }), params.dirPath));
  const fd = params.fsModule.openSync(params.dirPath, directoryOpenFlags());
  try {
    inspectFileIdentitySync(() => assertDirectory(params.fsModule.fstatSync(fd, { bigint: true }), params.dirPath), expected);
    // chmod ignores file-type bits; mask so raw stat modes are tolerated.
    params.mutation?.assert();
    params.fchmodSync?.(fd, params.mode & 0o7777);
  } finally {
    params.fsModule.closeSync(fd);
  }
}

export async function writeTempFile(params: {
  fsModule: AsyncTempFileSystem;
  tempPath: string;
  content: string | Uint8Array;
  mode: number;
  sync: boolean;
  onIdentity?: (identity: BigIntStats) => void;
  mutation?: AtomicMutation;
}): Promise<{ handle: FileHandle; identity: BigIntStats }> {
  params.mutation?.assert();
  const handle = await params.fsModule.open(params.tempPath, "wx", params.mode);
  try {
    // Custom adapters retain their async-only metadata contract.
    const inspect = () => params.fsModule === fs
      ? syncFs.fstatSync(handle.fd, { bigint: true }) : handle.stat({ bigint: true });
    const identity = await inspectFileIdentity(inspect);
    params.onIdentity?.(identity);
    params.mutation?.assert();
    await params.fsModule.writeFile(handle, params.content);
    await handle.chmod(params.mode);
    if (params.sync) {
      await syncFileBestEffort(handle);
    }
    await inspectFileIdentity(inspect, identity);
    return { handle, identity };
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Atomic temp write and close failed");
    }
    throw error;
  }
}

export function writeTempFileSync(params: Omit<
  Parameters<typeof writeTempFile>[0],
  "fsModule"
> & {
  fsModule: SyncTempFileSystem;
  fchmodSync?: SyncFchmod;
}): { fd: number; identity: BigIntStats } {
  params.mutation?.assert();
  const fd = params.fsModule.openSync(params.tempPath, "wx", params.mode);
  try {
    const identity = inspectFileIdentitySync(() => params.fsModule.fstatSync(fd, { bigint: true }));
    params.onIdentity?.(identity);
    params.mutation?.assert();
    params.fsModule.writeFileSync(fd, params.content);
    params.fchmodSync?.(fd, params.mode);
    if (params.sync) {
      syncFileBestEffortSync(fd, params.fsModule);
    }
    inspectFileIdentitySync(() => params.fsModule.fstatSync(fd, { bigint: true }), identity);
    return { fd, identity };
  } catch (error) {
    try {
      params.fsModule.closeSync(fd);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Atomic temp write and close failed");
    }
    throw error;
  }
}
