import syncFs, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { assertAsyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";

export function hasErrorCode(error: unknown, expected: string): boolean {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return false;
  }
  try {
    return Reflect.get(error as object, "code") === expected;
  } catch {
    return false;
  }
}

type OwnedPathCleanupStatus = "removed" | "name-absent" | "preserved";

export async function removeOwnedPath(params: {
  fsModule: Pick<typeof fs, "lstat" | "unlink">;
  pathname: string;
  identity?: BigIntStats;
}): Promise<OwnedPathCleanupStatus> {
  if (!params.identity) return "preserved";
  try {
    const current = params.fsModule === fs
      ? syncFs.lstatSync(params.pathname, { bigint: true })
      : await params.fsModule.lstat(params.pathname, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameFileIdentityForCleanup(current, params.identity)
    ) {
      return "preserved";
    }
    await params.fsModule.unlink(params.pathname);
    return "removed";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "name-absent";
    throw error;
  }
}

// Borrowed handle: the caller retains it until guarded cleanup finishes.
export async function cleanupPinnedFilePath(params: {
  pathname: string;
  handle: Pick<FileHandle, "fd">;
  identity?: BigIntStats;
  parentGuard: AnyAsyncDirectoryGuard;
  throwOnCleanupError?: boolean;
}): Promise<OwnedPathCleanupStatus> {
  if (!params.identity) return "preserved";
  try {
    const guard = params.parentGuard;
    if ([guard.stat.dev, guard.stat.ino].some(
      (value) => typeof value === "number" && !Number.isSafeInteger(value),
    )) return "preserved";
    await assertAsyncDirectoryGuard(guard);
    const parent = syncFs.lstatSync(guard.dir, { bigint: true });
    if (parent.isSymbolicLink() || !parent.isDirectory() ||
      !sameFileIdentityForCleanup(parent, guard.stat)) return "preserved";
    const opened = syncFs.fstatSync(params.handle.fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n ||
      !sameFileIdentityForCleanup(opened, params.identity)) return "preserved";
  } catch (error) {
    // Unverifiable authority must preserve the path and the original write failure.
    if (params.throwOnCleanupError &&
      !(error instanceof FsSafeError && error.category === "policy") &&
      !hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR") &&
      !hasErrorCode(error, "ELOOP")) throw error;
    return "preserved";
  }
  try {
    return await removeOwnedPath({
      fsModule: fs,
      pathname: params.pathname,
      identity: params.identity,
    });
  } catch (error) {
    if (params.throwOnCleanupError) throw error;
    return "preserved";
  }
}

