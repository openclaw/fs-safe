import path from "node:path";
import { withFileLock, withFileLockSync } from "./file-lock.js";
import { sha256Hex } from "./file-identity.js";
import type { RenameIdentityPolicy } from "./pinned-write.js";

export type { RenameIdentityPolicy };

export function validateRenameIdentity(policy: RenameIdentityPolicy | undefined): void {
  if (policy !== undefined && policy !== "strict" && policy !== "verify-content-with-lock") {
    throw new RangeError("renameIdentity must be strict or verify-content-with-lock");
  }
}

export function atomicExpectedContentHash(
  policy: RenameIdentityPolicy | undefined,
  content: string | Uint8Array,
): string | undefined {
  if (policy !== "verify-content-with-lock") return undefined;
  return sha256Hex(typeof content === "string" ? content : Buffer.from(content));
}

function lockOptions(filePath: string) {
  const resolved = path.resolve(filePath);
  return {
    managerKey: `fs-safe.atomic:${resolved}`,
    lockPath: path.join(path.dirname(resolved), `.fs-safe-atomic-${sha256Hex(resolved)}.lock`),
    staleMs: 30_000,
    timeoutMs: 5_000,
    payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
    retry: { retries: 5, minTimeout: 100, maxTimeout: 2_000, factor: 2 },
  } as const;
}

export async function withAtomicRenameIdentityLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withFileLock(filePath, lockOptions(filePath), fn);
}

export function withAtomicRenameIdentityLockSync<T>(filePath: string, fn: () => T): T {
  return withFileLockSync(filePath, lockOptions(filePath), fn);
}
