import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertSyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertExclusiveCreateLeaf } from "./exclusive-create.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { hasErrorCode } from "./file-cleanup.js";
import { isHardlinkFallbackError } from "./hardlink-fallback.js";
import type { PublishedWriteIdentity } from "./pinned-write-types.js";

// Node has no portable no-replace rename. Publish the completed stage by link,
// then remove its verified temporary name without yielding.
export function publishCopyStage(params: {
  temporaryPath: string;
  targetPath: string;
  fd: number;
  identity: BigIntStats;
  parentGuard: AnyAsyncDirectoryGuard;
  assertBeforeMutation?: () => void;
  onPublicationAttempt?: () => void;
  onPublished?: (identity: PublishedWriteIdentity) => void;
}): void {
  const { identity, temporaryPath, targetPath } = params;
  const assertCurrent = () => {
    assertSyncDirectoryGuard(params.parentGuard);
    const staged = fs.lstatSync(temporaryPath, { bigint: true });
    const opened = fs.fstatSync(params.fd, { bigint: true });
    if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1n ||
      !sameFileIdentityForCleanup(staged, identity) ||
      !sameFileIdentityForCleanup(opened, identity)) {
      throw new FsSafeError("path-mismatch", "exclusive copy stage changed before publication");
    }
  };
  assertCurrent();
  params.assertBeforeMutation?.();
  // Caller authority checks can synchronously replace a parent or staged entry.
  if (params.assertBeforeMutation) assertCurrent();
  // An observed collision needs no dispatch; errno after a link attempt remains ambiguous.
  if (fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
    throw new FsSafeError("already-exists", "destination already exists");
  }
  params.onPublicationAttempt?.();
  let renamed = false;
  try {
    fs.linkSync(temporaryPath, targetPath);
  } catch (error) {
    if (!isHardlinkFallbackError(error)) throw error;
    publishThroughPlaceholder(params, assertCurrent);
    renamed = true;
  }
  let observerRejected = false;
  let observerError: unknown;
  try {
    params.onPublished?.(identity);
  } catch (error) {
    observerRejected = true;
    observerError = error;
  }
  try {
    if (renamed) {
      assertSyncDirectoryGuard(params.parentGuard);
      if (fs.lstatSync(temporaryPath, { throwIfNoEntry: false })) {
        throw new FsSafeError("path-mismatch", "renamed copy stage still exists");
      }
      const target = fs.lstatSync(targetPath, { bigint: true });
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n ||
        !sameFileIdentityForCleanup(target, identity)) {
        throw new FsSafeError("path-mismatch", "renamed copy target changed after publication");
      }
    } else {
      const parent = fs.lstatSync(path.dirname(temporaryPath), { bigint: true });
      const current = fs.lstatSync(temporaryPath, { bigint: true });
      if (parent.isSymbolicLink() || !parent.isDirectory() ||
        !sameFileIdentityForCleanup(parent, params.parentGuard.stat) ||
        current.isSymbolicLink() || !current.isFile() ||
        !sameFileIdentityForCleanup(current, identity)) {
        throw new FsSafeError("path-mismatch", "published copy temporary name changed before cleanup");
      }
      // This removes the stage's name, never the published destination or source.
      fs.unlinkSync(temporaryPath);
    }
  } catch (error) {
    throw new FsSafeError("helper-failed", "published copy temporary cleanup failed", {
      cause: observerRejected ? new AggregateError([observerError, error], "observer and cleanup failed") : error,
      details: { publication: "published", path: targetPath, dev: identity.dev, ino: identity.ino, cleanup: "failed" },
    });
  }
  if (observerRejected) throw observerError;
}

function isEmptyPlaceholder(current: BigIntStats, identity: BigIntStats): boolean {
  return current.isFile() && !current.isSymbolicLink() && current.nlink === 1n &&
    current.size === 0n && sameFileIdentityForCleanup(current, identity);
}

function publishThroughPlaceholder(
  params: Parameters<typeof publishCopyStage>[0],
  assertCurrent: () => void,
): void {
  const { targetPath, temporaryPath } = params;
  // An empty placeholder can be observed before the completed stage atomically replaces it.
  // The stage proved directory write access; a real permission denial still fails O_EXCL.
  assertCurrent();
  let fd: number;
  try {
    assertExclusiveCreateLeaf(targetPath);
    fd = fs.openSync(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new FsSafeError("already-exists", "destination already exists", { cause: error });
    }
    throw error;
  }
  let placeholder: BigIntStats | undefined;
  try {
    try {
      placeholder = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
    assertCurrent();
    const current = fs.lstatSync(targetPath, { bigint: true, throwIfNoEntry: false });
    if (!current || !isEmptyPlaceholder(current, placeholder)) {
      throw new FsSafeError("path-mismatch", "exclusive copy placeholder changed before publication");
    }
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      assertSyncDirectoryGuard(params.parentGuard);
      const current = fs.lstatSync(targetPath, { bigint: true, throwIfNoEntry: false });
      if (current) {
        if (!placeholder) throw new FsSafeError("path-mismatch", "copy placeholder identity unavailable for cleanup");
        if (isEmptyPlaceholder(current, placeholder)) fs.unlinkSync(targetPath);
      }
    } catch (cleanupError) {
      throw new FsSafeError("helper-failed", "unpublished copy placeholder cleanup failed", {
        cause: new AggregateError([error, cleanupError], "publication and cleanup failed"),
        details: { publication: "not-published", path: targetPath, cleanup: "failed",
          ...(placeholder ? { dev: placeholder.dev, ino: placeholder.ino } : {}) },
      });
    }
    throw error;
  }
}
