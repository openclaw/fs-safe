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
  const handleStat = await handle.stat();
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
      const fdRealPath = await fs.realpath(fdPath);
      const fdRealStat = statOptions ? await fs.stat(fdRealPath, statOptions) : await fs.stat(fdRealPath);
      if (sameFileIdentity(handleStat, fdRealStat)) {
        return { realPath: fdRealPath, stat: fdRealStat };
      }
    } catch {
      // try next fd path
    }
  }

  try {
    const ioRealPath = await fs.realpath(ioPath);
    const ioRealStat = statOptions ? await fs.stat(ioRealPath, statOptions) : await fs.stat(ioRealPath);
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
    parentReal = await fs.realpath(path.dirname(ioPath));
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
      const candidateStat = statOptions ? await fs.lstat(candidatePath, statOptions) : await fs.lstat(candidatePath);
      if (candidateStat.isFile() && sameFileIdentity(handleStat, candidateStat)) {
        const realPath = await fs.realpath(candidatePath);
        const stat = statOptions ? await fs.stat(realPath, statOptions) : await fs.stat(realPath);
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
