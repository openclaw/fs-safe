import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertSyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import type { PublishedWriteIdentity } from "./pinned-write.js";
import { isHardlinkCapabilityError } from "./linux-rename-command.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { openSiblingRenameParentSync, renameSiblingNoReplaceSync } from "./sibling-rename-command.js";
import { createSuppressedError } from "./suppressed-error.js";

type CopyStagePublication = {
  temporaryPath: string;
  targetPath: string;
  fd: number;
  identity: BigIntStats;
  parentGuard: AnyAsyncDirectoryGuard;
  assertBeforeMutation?: () => void;
  rejectFinalSymlink?: boolean;
  onPublished?: (identity: PublishedWriteIdentity) => void;
  onIndeterminate?: () => void;
};

function assertStage(params: CopyStagePublication): BigIntStats {
  const { identity, temporaryPath, targetPath, parentGuard } = params;
  assertSyncDirectoryGuard(parentGuard);
  const parent = fs.lstatSync(path.dirname(temporaryPath), { bigint: true });
  const staged = fs.lstatSync(temporaryPath, { bigint: true });
  const opened = fs.fstatSync(params.fd, { bigint: true });
  if (path.dirname(targetPath) !== path.dirname(temporaryPath) ||
    path.resolve(parentGuard.dir) !== path.resolve(path.dirname(temporaryPath)) ||
    parent.isSymbolicLink() || !parent.isDirectory() ||
    !sameFileIdentityForCleanup(parent, parentGuard.stat) ||
    !staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1n ||
    !opened.isFile() || opened.nlink !== 1n ||
    !sameFileIdentityForCleanup(staged, identity) || !sameFileIdentityForCleanup(opened, identity)) {
    throw new FsSafeError("path-mismatch", "exclusive copy stage changed before publication");
  }
  assertFinalSymlinkRejected(targetPath, params.rejectFinalSymlink);
  return parent;
}

function publishWithCommand(params: CopyStagePublication): void {
  let parentFd: number | undefined;
  let dispatched = false;
  let committed = false;
  let indeterminate = false;
  let failed = false;
  let operationError: unknown;
  try {
    const parentIdentity = assertStage(params);
    parentFd = openSiblingRenameParentSync(params.parentGuard.realPath, parentIdentity);
    warnNativeFallback("exclusive-copy-atomic-publication", "A system command preserves atomic no-replace publication when hardlinks are unavailable; process startup adds overhead.");
    params.assertBeforeMutation?.();
    assertStage(params);
    dispatched = true;
    renameSiblingNoReplaceSync({
      parent: { path: params.parentGuard.realPath, identity: parentIdentity, fd: parentFd },
      source: { basename: path.basename(params.temporaryPath), identity: params.identity, links: 1n, fd: params.fd },
      targetBasename: path.basename(params.targetPath),
    });
    committed = true;
  } catch (error) {
    const reported = error as { details?: { commit?: unknown }; commit?: unknown; code?: string } | undefined;
    const commit = reported?.details?.commit ?? reported?.commit;
    if (dispatched && commit === "committed") committed = true;
    else if (dispatched && commit !== "not-attempted" &&
      (commit === "unknown" || !["EEXIST", "ENOTEMPTY"].includes(reported?.code ?? ""))) {
      indeterminate = true;
    }
    operationError = error instanceof FsSafeError && error.code === "already-exists"
      ? Object.assign(new Error("exclusive copy target already exists", { cause: error }), { code: "EEXIST" }) : error;
    failed = true;
  }
  // Settle ownership before observers or parent close can fail.
  if (indeterminate) {
    try { params.onIndeterminate?.(); } catch (error) {
      operationError = createSuppressedError(error, operationError, "publication and preservation callback failed");
    }
  }
  if (committed) {
    try { params.onPublished?.(params.identity); } catch (error) {
      operationError = failed ? createSuppressedError(error, operationError, "publication and observer failed") : error;
      failed = true;
    }
  }
  if (parentFd !== undefined) {
    try { fs.closeSync(parentFd); } catch (error) {
      operationError = failed ? createSuppressedError(error, operationError, "publication and parent close failed") : error;
      failed = true;
    }
  }
  if (failed) throw operationError;
}

// Publish the completed stage without copying or replacing an existing name.
export function publishCopyStage(params: CopyStagePublication): void {
  const { identity, temporaryPath, targetPath } = params;
  params.assertBeforeMutation?.();
  assertStage(params);
  try {
    fs.linkSync(temporaryPath, targetPath);
  } catch (error) {
    if (!isHardlinkCapabilityError(error)) throw error;
    publishWithCommand(params);
    return;
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
