import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";

export async function resolveOpenedFileRealPathForHandle(
  handle: FileHandle,
  ioPath: string,
): Promise<string> {
  const handleStat = await handle.stat();
  return await resolveOpenedFileRealPathForFd(handle.fd, handleStat, ioPath);
}

export async function resolveOpenedFileRealPathForFd(
  fd: number,
  handleStat: FileIdentityStat,
  ioPath: string,
): Promise<string> {
  const statOptions = typeof handleStat.dev === "bigint" || typeof handleStat.ino === "bigint"
    ? { bigint: true as const } : undefined;
  const fdCandidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${fd}`];
  for (const fdPath of fdCandidates) {
    try {
      const fdRealPath = await fs.realpath(fdPath);
      const fdRealStat = statOptions ? await fs.stat(fdRealPath, statOptions) : await fs.stat(fdRealPath);
      if (sameFileIdentity(handleStat, fdRealStat)) {
        return fdRealPath;
      }
    } catch {
      // try next fd path
    }
  }

  try {
    const ioRealPath = await fs.realpath(ioPath);
    const ioRealStat = statOptions ? await fs.stat(ioRealPath, statOptions) : await fs.stat(ioRealPath);
    if (sameFileIdentity(handleStat, ioRealStat)) {
      return ioRealPath;
    }
  } catch (err) {
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }
  const parentResolved = await resolveOpenedFileRealPathFromParent(handleStat, ioPath, statOptions);
  if (parentResolved) {
    return parentResolved;
  }
  throw new FsSafeError("path-mismatch", "unable to resolve opened file path");
}

async function resolveOpenedFileRealPathFromParent(
  handleStat: FileIdentityStat,
  ioPath: string,
  statOptions?: { bigint: true },
): Promise<string | null> {
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
        return await fs.realpath(candidatePath);
      }
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }
  }
  return null;
}
