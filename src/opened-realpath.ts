import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { openedPathResolutionError } from "./opened-file-failure.js";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";

export async function resolveOpenedFileRealPathForHandle(
  handle: FileHandle,
  ioPath: string,
): Promise<string> {
  const handleStat = fsSync.fstatSync(handle.fd);
  return (await resolveOpenedFileRealPathForFd(handle.fd, handleStat, ioPath)).realPath;
}

export function resolveOpenedFileRealPathForFd(
  fd: number,
  handleStat: { dev: bigint; ino: bigint },
  ioPath: string,
): Promise<{ realPath: string; stat: BigIntStats }>;
export function resolveOpenedFileRealPathForFd(
  fd: number,
  handleStat: FileIdentityStat,
  ioPath: string,
): Promise<{ realPath: string; stat: Stats | BigIntStats }>;
export async function resolveOpenedFileRealPathForFd(
  fd: number,
  handleStat: FileIdentityStat,
  ioPath: string,
): Promise<{ realPath: string; stat: Stats | BigIntStats }> {
  const statOptions = typeof handleStat.dev === "bigint" || typeof handleStat.ino === "bigint"
    ? { bigint: true as const } : undefined;
  const fdCandidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]
      : [];
  for (const fdPath of fdCandidates) {
    try {
      const fdRealPath = fsSync.realpathSync.native(fdPath);
      const fdRealStat = statOptions ? fsSync.statSync(fdRealPath, statOptions) : fsSync.statSync(fdRealPath);
      if (sameFileIdentity(handleStat, fdRealStat)) {
        return { realPath: fdRealPath, stat: fdRealStat };
      }
    } catch {
      // try next fd path
    }
  }

  try {
    const ioRealPath = fsSync.realpathSync.native(ioPath);
    const ioRealStat = statOptions ? fsSync.statSync(ioRealPath, statOptions) : fsSync.statSync(ioRealPath);
    if (sameFileIdentity(handleStat, ioRealStat)) {
      return { realPath: ioRealPath, stat: ioRealStat };
    }
  } catch (err) {
    if (!isNotFoundPathError(err)) {
      // Windows can fail here on a deleted-but-open file. Brand only this
      // resolver operation; the caller must still prove unlink on the same fd.
      if (process.platform === "win32" && err instanceof Error &&
        ["EPERM", "EBADF"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        throw openedPathResolutionError(err);
      }
      throw err;
    }
  }
  const parentResolved = await resolveOpenedFileRealPathFromParent(handleStat, ioPath, statOptions);
  if (parentResolved) {
    return parentResolved;
  }
  throw openedPathResolutionError();
}

async function resolveOpenedFileRealPathFromParent(
  handleStat: FileIdentityStat,
  ioPath: string,
  statOptions?: { bigint: true },
): Promise<{ realPath: string; stat: Stats | BigIntStats } | null> {
  let parentReal: string;
  try {
    parentReal = fsSync.realpathSync.native(path.dirname(ioPath));
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return null;
    }
    throw err;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(parentReal);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return null;
    }
    throw err;
  }

  for (const entry of entries.toSorted()) {
    const candidatePath = path.join(parentReal, entry);
    try {
      const candidateStat = statOptions ? fsSync.lstatSync(candidatePath, statOptions) : fsSync.lstatSync(candidatePath);
      if (candidateStat.isFile() && sameFileIdentity(handleStat, candidateStat)) {
        const realPath = fsSync.realpathSync.native(candidatePath);
        const stat = statOptions ? fsSync.statSync(realPath, statOptions) : fsSync.statSync(realPath);
        if (sameFileIdentity(handleStat, stat)) return { realPath, stat };
      }
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }
  }
  return null;
}
