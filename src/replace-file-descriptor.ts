import syncFs, { type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";

type AsyncTempFileSystem = Pick<typeof fs, "lstat" | "open" | "writeFile">;
type SyncTempFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "fsyncSync" | "lstatSync" | "openSync" | "writeFileSync"
>;

export type SyncFchmod = (fd: number, mode: number) => void;

function directoryOpenFlags(): number {
  return (
    syncFs.constants.O_RDONLY |
    syncFs.constants.O_DIRECTORY |
    syncFs.constants.O_NOFOLLOW |
    syncFs.constants.O_NONBLOCK
  );
}

function assertDirectory(identity: Stats, dirPath: string): void {
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new FsSafeError("not-file", `Atomic replace parent must be a real directory: ${dirPath}`);
  }
}

function assertSameDirectory(expected: Stats, opened: Stats, dirPath: string): void {
  assertDirectory(opened, dirPath);
  if (!sameFileIdentity(expected, opened)) {
    throw new FsSafeError(
      "path-mismatch",
      `Atomic replace parent changed before its mode could be applied: ${dirPath}`,
    );
  }
}

export async function applyDirectoryMode(params: {
  fsModule: AsyncTempFileSystem;
  dirPath: string;
  mode: number;
}): Promise<void> {
  // Node does not enforce POSIX directory modes on Windows, and its directory
  // descriptors are not consistently openable. mkdir(mode) remains the only
  // bounded behavior there; never fall back to a pathname chmod.
  if (process.platform === "win32") {
    return;
  }

  const expected = await params.fsModule.lstat(params.dirPath);
  assertDirectory(expected, params.dirPath);
  const handle = await params.fsModule.open(params.dirPath, directoryOpenFlags());
  try {
    assertSameDirectory(expected, await handle.stat(), params.dirPath);
    await handle.chmod(params.mode);
  } finally {
    await handle.close();
  }
}

export function applyDirectoryModeSync(params: {
  fsModule: SyncTempFileSystem;
  dirPath: string;
  mode: number;
  fchmodSync?: SyncFchmod;
}): void {
  if (process.platform === "win32") {
    return;
  }

  const expected = params.fsModule.lstatSync(params.dirPath);
  assertDirectory(expected, params.dirPath);
  const fd = params.fsModule.openSync(params.dirPath, directoryOpenFlags());
  try {
    assertSameDirectory(expected, params.fsModule.fstatSync(fd), params.dirPath);
    params.fchmodSync?.(fd, params.mode);
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
}): Promise<Stats> {
  const handle = await params.fsModule.open(params.tempPath, "wx", params.mode);
  try {
    await params.fsModule.writeFile(handle, params.content);
    await handle.chmod(params.mode);
    if (params.sync) {
      try {
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }
    }
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

export function writeTempFileSync(params: {
  fsModule: SyncTempFileSystem;
  tempPath: string;
  content: string | Uint8Array;
  mode: number;
  fchmodSync?: SyncFchmod;
  sync: boolean;
}): Stats {
  const fd = params.fsModule.openSync(params.tempPath, "wx", params.mode);
  try {
    params.fsModule.writeFileSync(fd, params.content);
    params.fchmodSync?.(fd, params.mode);
    if (params.sync) {
      try {
        params.fsModule.fsyncSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }
    }
    return params.fsModule.fstatSync(fd);
  } finally {
    params.fsModule.closeSync(fd);
  }
}
