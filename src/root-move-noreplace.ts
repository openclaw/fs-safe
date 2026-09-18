import fsSync, { type Stats } from "node:fs";
import path from "node:path";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import {
  closeNativeParentAdmission,
  openNativeParentAdmission,
  openNativeRootAdmission,
  type NativeParentAdmission,
} from "./native-parent-admission.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { resolveRootPathSync } from "./root-path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import {
  fileNotFoundError,
  hardlinkedPathNotAllowedError,
  isAlreadyExistsError,
  normalizePinnedPathError,
  outsideWorkspaceError,
} from "./root-errors.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { movePathNoReplacePortable, type NoReplaceMoveOptions, type NoReplaceMovePaths } from "./root-move-portable.js";

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

function admitMovePath(root: RootContext, parent: NativeParentAdmission, basename: string): string {
  const admitted = admitPathInsideRoot({
    rootPath: root.rootReal,
    candidatePath: path.join(parent.guard.realPath, basename),
    rootIdentity: root.rootIdentity,
  });
  if (!admitted) throw outsideWorkspaceError();
  return admitted.path;
}

function nativePrimitiveUnavailable(error: unknown, allowInvalidParameter = false): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return !(error instanceof FsSafeError) &&
    (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || (allowInvalidParameter && code === "EINVAL"));
}

function normalizeMoveError(error: unknown): unknown {
  if (isNotFoundPathError(error)) {
    return fileNotFoundError(error instanceof Error ? error : undefined);
  }
  return error;
}

export async function movePathNoReplace(
  root: RootContext,
  params: NoReplaceMoveOptions,
  paths: NoReplaceMovePaths,
): Promise<void> {
  try {
    fsSync.lstatSync(paths.targetPath);
    throw new FsSafeError("already-exists", "destination exists");
  } catch (error) {
    if (error instanceof FsSafeError) throw error;
    if (!isNotFoundPathError(error)) throw error;
    // Advisory fast rejection only. The selected primitive owns collisions.
  }
  const binding = getNativeBinding();
  if (!binding || typeof binding.renameNoReplace !== "function" || typeof binding.openBeneath !== "function" ||
    typeof binding.closeOwnedFd !== "function" ||
    (process.platform === "win32" && typeof root.rootIdentity.ino !== "bigint" &&
      typeof binding.fstatIdentity !== "function")) {
    return await movePathNoReplacePortable(root, params, paths);
  }
  const outcome = await movePathNoReplaceNative(binding, root, params, paths);
  if (outcome === "moved") return;
  await movePathNoReplacePortable(root, params, paths, outcome === "rename-unavailable");
}

async function movePathNoReplaceNative(
  binding: NativeBinding,
  root: RootContext,
  params: NoReplaceMoveOptions,
  paths: NoReplaceMovePaths,
): Promise<"moved" | "admission-unavailable" | "rename-unavailable"> {
  let unsupportedAdmissionError: unknown;
  const admissionBinding = {
    closeOwnedFd: binding.closeOwnedFd.bind(binding),
    fstatIdentity: typeof binding.fstatIdentity === "function" ? binding.fstatIdentity.bind(binding) : undefined,
    openBeneath: (...args: Parameters<NativeBinding["openBeneath"]>) => {
      try {
        return binding.openBeneath(...args);
      } catch (error) {
        if (nativePrimitiveUnavailable(error)) unsupportedAdmissionError = error;
        throw error;
      }
    },
  } as NativeBinding;
  const rootAdmission = await openNativeRootAdmission(binding, {
    rootPath: root.rootReal,
    rootIdentity: root.rootIdentity,
    operation: "native move",
  });
  let sourceParent: NativeParentAdmission | undefined;
  let targetParent: NativeParentAdmission | undefined;
  let failed = false;
  let operationError: unknown;
  let unsupportedRename = false;
  try {
    const sourceParentRelativePath = nativeParentRelativePath(root.rootReal, paths.sourceParentPath);
    sourceParent = await openNativeParentAdmission(
      admissionBinding,
      rootAdmission,
      sourceParentRelativePath,
    );
    const targetParentRelativePath = nativeParentRelativePath(root.rootReal, paths.targetParentPath);
    targetParent = targetParentRelativePath === sourceParentRelativePath
      ? sourceParent
      : await openNativeParentAdmission(admissionBinding, rootAdmission, targetParentRelativePath);
    const parentAdmissions = targetParent === sourceParent
      ? [sourceParent]
      : [sourceParent, targetParent];
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", paths.targetPath);
    const admittedSourcePath = admitMovePath(root, sourceParent, path.basename(paths.sourcePath));
    const admittedTargetPath = admitMovePath(root, targetParent, path.basename(paths.targetPath));
    if (params.denyMutations) {
      // Native admission can follow a newly introduced contained parent alias.
      // Authorize the selected names, then recheck every retained directory.
      await assertMutationNotDenied(admittedSourcePath, params.denyMutations, { protectAncestors: true });
      await assertMutationNotDenied(admittedTargetPath, params.denyMutations, { protectAncestors: true });
    }
    await assertRootIdentityCurrent(root);
    for (const admission of parentAdmissions) assertSyncDirectoryGuard(admission.guard);
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
    if (params.assertBeforeMutation || params.mutationSymlinks === "reject") {
      // Do not carry directory freshness across the live authority callback.
      assertRootIdentityCurrentSync(root);
      if (params.mutationSymlinks === "reject") {
        // Validate both full pre-native routes; selected canonical names have
        // already erased any parent symlink followed during admission.
        for (const absolutePath of [paths.sourcePath, paths.targetPath]) {
          resolveRootPathSync({
            absolutePath,
            rootPath: root.rootReal,
            rootCanonicalPath: root.rootReal,
            rootIdentity: root.rootIdentity,
            boundaryLabel: "root",
            rejectSymlinks: true,
            rejectFinalSymlink: true,
          });
        }
      }
      for (const admission of parentAdmissions) assertSyncDirectoryGuard(admission.guard);
    }
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
      // Only these syscall errors prove no rename occurred. Hook, I/O,
      // post-mutation and close failures must never trigger another move.
      unsupportedRename = nativePrimitiveUnavailable(error, true);
      throw normalizeMoveError(error);
    }
    try {
      for (const admission of parentAdmissions) await assertAsyncDirectoryGuard(admission.guard);
    } catch (error) {
      throw normalizePinnedPathError(error);
    }
  } catch (error) {
    failed = true;
    operationError = error;
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
    if (unsupportedRename) return "rename-unavailable";
    if (unsupportedAdmissionError !== undefined && operationError === unsupportedAdmissionError) return "admission-unavailable";
    throw operationError;
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, "native move descriptor closes failed");
  }
  return "moved";
}
