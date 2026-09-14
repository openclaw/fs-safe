import fsSync, { type Stats } from "node:fs";
import path from "node:path";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import {
  closeNativeParentAdmission,
  openNativeParentAdmission,
  openNativeRootAdmission,
  type NativeParentAdmission,
} from "./native-parent-admission.js";
import { getNativeBinding } from "./native.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import {
  fileNotFoundError,
  hardlinkedPathNotAllowedError,
  isAlreadyExistsError,
  normalizePinnedPathError,
  outsideWorkspaceError,
} from "./root-errors.js";
import { assertFinalSymlinkRejected, type MutationSymlinkPolicy } from "./root-symlink-policy.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function nativeParentRelativePath(rootReal: string, parentPath: string): string {
  const relative = path.relative(rootReal, parentPath);
  if (relative === "" || relative === ".") return "";
  const firstSegment = relative.split(path.sep)[0];
  if (
    firstSegment === ".." ||
    path.isAbsolute(relative)
  ) {
    throw outsideWorkspaceError();
  }
  return relative.split(path.sep).join(path.posix.sep);
}

function nativePrimitiveUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function normalizeMoveError(error: unknown): unknown {
  if (isNotFoundPathError(error)) {
    return fileNotFoundError(error instanceof Error ? error : undefined);
  }
  if (nativePrimitiveUnavailable(error)) {
    return new FsSafeError("helper-unavailable", "native no-replace move is unavailable", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

function normalizeRenameNoReplaceError(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "EINVAL") {
    return new FsSafeError("helper-unavailable", "native no-replace move is unavailable on this filesystem", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return normalizeMoveError(error);
}

export async function movePathNoReplaceNative(
  root: RootContext,
  params: {
    assertBeforeMutation?: () => void;
    mutationSymlinks?: MutationSymlinkPolicy;
  },
  paths: {
    sourcePath: string;
    sourceParentPath: string;
    targetPath: string;
    targetParentPath: string;
  },
): Promise<void> {
  try {
    fsSync.lstatSync(paths.targetPath);
    throw new FsSafeError("already-exists", "destination exists");
  } catch (error) {
    if (error instanceof FsSafeError) throw error;
    if (!isNotFoundPathError(error)) throw error;
    // Advisory fast rejection only. renameNoReplace owns the collision decision.
  }
  const binding = getNativeBinding();
  if (!binding || typeof binding.renameNoReplace !== "function") {
    throw new FsSafeError("helper-unavailable", "native no-replace move is unavailable");
  }
  const rootAdmission = await openNativeRootAdmission(binding, {
    rootPath: root.rootReal,
    rootIdentity: root.rootIdentity,
    operation: "native move",
  });
  let sourceParent: NativeParentAdmission | undefined;
  let targetParent: NativeParentAdmission | undefined;
  let failed = false;
  let operationError: unknown;
  try {
    const sourceParentRelativePath = nativeParentRelativePath(root.rootReal, paths.sourceParentPath);
    sourceParent = await openNativeParentAdmission(
      binding,
      rootAdmission,
      sourceParentRelativePath,
    );
    const targetParentRelativePath = nativeParentRelativePath(root.rootReal, paths.targetParentPath);
    targetParent = targetParentRelativePath === sourceParentRelativePath
      ? sourceParent
      : await openNativeParentAdmission(binding, rootAdmission, targetParentRelativePath);
    const parentAdmissions = targetParent === sourceParent
      ? [sourceParent]
      : [sourceParent, targetParent];
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", paths.targetPath);
    await assertRootIdentityCurrent(root);
    for (const admission of parentAdmissions) assertSyncDirectoryGuard(admission.guard);

    const admittedSourcePath = path.join(sourceParent.guard.realPath, path.basename(paths.sourcePath));
    const admittedTargetPath = path.join(targetParent.guard.realPath, path.basename(paths.targetPath));
    let sourceStat: Stats;
    try {
      sourceStat = fsSync.lstatSync(admittedSourcePath);
    } catch (error) {
      throw normalizeMoveError(error);
    }
    if (sourceStat.isSymbolicLink()) {
      throw new FsSafeError("symlink", "symlink not allowed");
    }
    if (sourceStat.isFile() && sourceStat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }
    if (sourceStat.isDirectory()) {
      throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
    }
    assertFinalSymlinkRejected(admittedTargetPath, params.mutationSymlinks !== undefined);
    params.assertBeforeMutation?.();
    try {
      binding.renameNoReplace(
        sourceParent.fd,
        path.basename(paths.sourcePath),
        targetParent.fd,
        path.basename(paths.targetPath),
      );
    } catch (error) {
      if (isAlreadyExistsError(error) || (error as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY") {
        throw new FsSafeError("already-exists", "destination exists", {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw normalizeRenameNoReplaceError(error);
    }
    try {
      for (const admission of parentAdmissions) await assertAsyncDirectoryGuard(admission.guard);
    } catch (error) {
      throw normalizePinnedPathError(error);
    }
  } catch (error) {
    failed = true;
    operationError = normalizeMoveError(error);
  }

  const closeErrors: unknown[] = [];
  const closedFds = new Set<number>();
  for (const admission of [targetParent, sourceParent]) {
    if (!admission || closedFds.has(admission.fd)) continue;
    closedFds.add(admission.fd);
    try {
      closeNativeParentAdmission(admission);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  try {
    await rootAdmission.root.close();
  } catch (error) {
    closeErrors.push(error);
  }
  if (failed) {
    if (closeErrors.length > 0) {
      const closeError = closeErrors.length === 1
        ? closeErrors[0]
        : new AggregateError(closeErrors, "native move descriptor closes failed");
      throw createSuppressedError(closeError, operationError, "native move and descriptor close failed");
    }
    throw operationError;
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, "native move descriptor closes failed");
  }
}
