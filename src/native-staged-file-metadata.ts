import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";

/** Exact nonprivate stage facts from one fresh named/retained observation. */
export function nativeStagedFileMode(
  binding: NativeBinding, parentFd: number, name: string, fd: number, expectedMode?: number,
): number | undefined {
  if (typeof binding.stagedFileMetadata !== "function") return undefined;
  const stat = binding.stagedFileMetadata(parentFd, name, fd);
  if (!stat || typeof stat.mode !== "bigint" || stat.mode < 0n || stat.mode > 0xffff_ffffn ||
    typeof stat.nlink !== "bigint" || stat.nlink !== 1n || (stat.mode & 0o170000n) !== 0o100000n) {
    throw new FsSafeError("path-mismatch", "staged entry no longer names the exclusive created file");
  }
  const mode = Number(stat.mode & 0o7777n);
  if (expectedMode !== undefined && mode !== expectedMode) {
    throw new FsSafeError("insecure-permissions", "filesystem did not enforce the staged file mode");
  }
  return mode;
}
