import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import { hasErrorCode } from "./file-cleanup.js";

/** Retain the allocation without retaining Linux's filesystem open handle. */
export function openPublicationPin(fd: number): number {
  if (!Number.isInteger(fd) || fd < 0) throw new FsSafeError("path-mismatch", "invalid publication descriptor");
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    if (fs.statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) {
      throw new FsSafeError("helper-unavailable", "publication recovery requires a trusted procfs fd namespace");
    }
    // O_PATH follows the kernel-owned fd link without calling the backing
    // filesystem's open operation. Its path reference prevents inode reuse.
    return fs.openSync(`/proc/self/fd/${fd}`, 0x200000);
  }
  if (process.platform === "darwin") {
    // fdescfs duplicates the held descriptor; unavailable recovery stays closed.
    try { return fs.openSync(`/dev/fd/${fd}`, fs.constants.O_RDONLY); }
    catch (error) {
      if (!hasErrorCode(error, "EACCES")) throw error;
      return fs.openSync(`/dev/fd/${fd}`, fs.constants.O_WRONLY);
    }
  }
  throw new FsSafeError("helper-unavailable", "publication recovery cannot retain the original inode on this platform");
}
