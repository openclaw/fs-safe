import fsSync from "node:fs";
import fs from "node:fs/promises";
import { hasNodeErrorCode } from "./path.js";

export function resolveNonblockingWriteFlag(
  constants: Partial<Pick<typeof fsSync.constants, "O_NONBLOCK">> = fsSync.constants,
): number {
  return process.platform !== "win32" && typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;
}

function isNonblockingWriteEnxio(error: unknown, flags: number): boolean {
  return hasNodeErrorCode(error, "ENXIO") &&
    (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === fsSync.constants.O_WRONLY &&
    (flags & resolveNonblockingWriteFlag()) !== 0;
}

// A no-reader FIFO rejects a nonblocking write-only open before fstat is possible.
// Reclassify only a confirmed non-regular path; inconclusive races keep the errno.
export async function isNonRegularWriteOpenError(
  error: unknown,
  filePath: string,
  flags: number,
): Promise<boolean> {
  if (!isNonblockingWriteEnxio(error, flags)) return false;
  try {
    return !(await fs.lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function isNonRegularWriteOpenErrorSync(
  error: unknown,
  filePath: string,
  flags: number,
): boolean {
  if (!isNonblockingWriteEnxio(error, flags)) return false;
  try {
    return !fsSync.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}
