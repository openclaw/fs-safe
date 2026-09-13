import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import type { PublishedWriteIdentity } from "./pinned-write.js";

// Node has no portable no-replace rename. Link only our completed private stage,
// then unlink it in the same JS turn so local readers never observe two names.
export function publishCopyStage(params: {
  temporaryPath: string;
  targetPath: string;
  fd: number;
  identity: BigIntStats;
  parentGuard: AnyAsyncDirectoryGuard;
  assertBeforeMutation?: () => void;
  onPublished?: (identity: PublishedWriteIdentity) => void;
}): void {
  const { identity, temporaryPath, targetPath } = params;
  const staged = fs.lstatSync(temporaryPath, { bigint: true });
  const opened = fs.fstatSync(params.fd, { bigint: true });
  if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1n ||
    !sameFileIdentityForCleanup(staged, identity) ||
    !sameFileIdentityForCleanup(opened, identity)) {
    throw new FsSafeError("path-mismatch", "exclusive copy stage changed before publication");
  }
  params.assertBeforeMutation?.();
  fs.linkSync(temporaryPath, targetPath);
  let observerRejected = false;
  let observerError: unknown;
  try {
    params.onPublished?.(identity);
  } catch (error) {
    observerRejected = true;
    observerError = error;
  }
  try {
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
  } catch (error) {
    throw new FsSafeError("helper-failed", "published copy temporary cleanup failed", {
      cause: observerRejected ? new AggregateError([observerError, error], "observer and cleanup failed") : error,
      details: { publication: "published", path: targetPath, dev: identity.dev, ino: identity.ino, cleanup: "failed" },
    });
  }
  if (observerRejected) throw observerError;
}
