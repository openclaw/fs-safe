import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

type ProcDirectory = { path: string; opened: BigIntStats; followed: BigIntStats };
function inspect(fd: number, expected: Pick<BigIntStats, "dev" | "ino">, namespaceType: bigint): ProcDirectory {
  // Authenticate the descriptor namespace, not the followed filesystem. Host
  // mount-namespace integrity is trusted; privileged mount replacement is not covered.
  if (process.platform !== "linux" || namespaceType !== 0x9fa0n) {
    throw new FsSafeError("path-mismatch", "directory operation requires a trusted procfs fd namespace");
  }
  if (!Number.isSafeInteger(fd) || fd < 0) throw new FsSafeError("path-mismatch", "invalid directory descriptor");
  const path = "/proc/self/fd/" + fd;
  const opened = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), expected);
  const followed = inspectFileIdentitySync(() => fsSync.statSync(path, { bigint: true }), expected);
  if (!opened.isDirectory() || !followed.isDirectory()) throw new FsSafeError("not-file", "descriptor must reference a real directory");
  return { path, opened, followed };
}

/** The caller must retain exclusive descriptor ownership through every use. */
export async function inspectDirectoryProcFd(fd: number, expected: Pick<BigIntStats, "dev" | "ino">): Promise<ProcDirectory> {
  const namespace = await fs.statfs("/proc/self/fd", { bigint: true });
  return inspect(fd, expected, namespace.type);
}
export function inspectDirectoryProcFdSync(fd: number, expected: Pick<BigIntStats, "dev" | "ino">): ProcDirectory {
  return inspect(fd, expected, fsSync.statfsSync("/proc/self/fd", { bigint: true }).type);
}
