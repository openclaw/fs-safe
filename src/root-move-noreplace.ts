import fsSync, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import type { RootMoveOptions } from "./root-options.js";
import {
  openNativeParentAdmission,
  openNativeRootAdmission,
  type NativeParentAdmission,
} from "./native-parent-admission.js";
import { requireNativeBinding } from "./native.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { resolveRootPathSync } from "./root-path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import {
  errorCauseOptions,
  fileNotFoundError,
  hardlinkedPathNotAllowedError,
  isAlreadyExistsError,
  normalizePinnedPathError,
  outsideWorkspaceError,
} from "./root-errors.js";
import { assertFinalSymlinkRejected, mutationSymlinkResolution } from "./root-symlink-policy.js";
import { PATH_ALIAS_POLICIES } from "./path-policy.js";
import { createSuppressedError } from "./suppressed-error.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
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

function admitMovePath(root: RootContext, parent: NativeParentAdmission, basename: string): string {
  const admitted = admitPathInsideRoot({
    rootPath: root.rootReal,
    candidatePath: path.join(parent.guard.realPath, basename),
    rootIdentity: root.rootIdentity,
  });
  if (!admitted) throw outsideWorkspaceError();
  return admitted.path;
}

function nativePrimitiveUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function normalizeMoveError(error: unknown): unknown {
  if (error instanceof FsSafeError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "path-mismatch" || code === "hardlink") {
    return new FsSafeError(code, "native move source changed", errorCauseOptions(error));
  }
  if (code === "ELOOP") return new FsSafeError("symlink", "native move source is a symlink", errorCauseOptions(error));
  if (isNotFoundPathError(error)) {
    return fileNotFoundError(error instanceof Error ? error : undefined);
  }
  if (nativePrimitiveUnavailable(error)) {
    return new FsSafeError("helper-unavailable", "native move is unavailable", errorCauseOptions(error));
  }
  return error;
}

function normalizeRenameNoReplaceError(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "EINVAL") {
    return new FsSafeError(
      "helper-unavailable",
      "native no-replace move is unavailable on this filesystem",
      errorCauseOptions(error),
    );
  }
  return normalizeMoveError(error);
}

export function admitMoveSourceStat<T extends Stats | BigIntStats>(stat: T, overwrite = false): T {
  if (stat.isSymbolicLink()) {
    throw new FsSafeError("symlink", "symlink not allowed");
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw hardlinkedPathNotAllowedError();
  }
  if (!overwrite && stat.isDirectory()) {
    throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
  }
  return stat;
}

export async function movePathNative(
  root: RootContext,
  params: Pick<RootMoveOptions, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks">,
  paths: {
    sourcePath: string;
    sourceParentPath: string;
    targetPath: string;
    targetParentPath: string;
    sourceOriginalPath?: string;
    targetOriginalPath?: string;
    sourceCanonicalPath?: string;
    targetCanonicalPath?: string;
    expectedSourceIdentity?: BigIntStats;
  },
  overwrite = false,
): Promise<void> {
  if (!overwrite) try {
    fsSync.lstatSync(paths.targetPath);
    throw new FsSafeError("already-exists", "destination exists");
  } catch (error) {
    if (error instanceof FsSafeError) throw error;
    if (!isNotFoundPathError(error)) throw error;
    // Advisory fast rejection only. renameNoReplace owns the collision decision.
  }
  const binding = requireNativeBinding();
  if (typeof (overwrite ? binding.renameReplaceWithIdentity : binding.renameNoReplace) !== "function") {
    throw new FsSafeError("helper-unavailable", "native move is unavailable");
  }
  const rootAdmission = await openNativeRootAdmission(binding, {
    rootPath: root.rootReal,
    rootIdentity: root.rootIdentity,
    operation: "native move",
    searchOnly: true,
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
    // Overwrite publication always binds an exact source; no-clobber retains
    // its existing callback-dependent identity contract.
    const sourceStat = overwrite || params.assertBeforeMutation
      ? inspectFileIdentitySync(() => admitMoveSourceStat(fsSync.lstatSync(admittedSourcePath, { bigint: true }), overwrite), paths.expectedSourceIdentity)
      : undefined;
    if (!sourceStat) admitMoveSourceStat(fsSync.lstatSync(admittedSourcePath));
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
    // The callback can change a leaf without replacing its admitted parent.
    if (overwrite && params.assertBeforeMutation) {
      for (const [original, selected, expected, policy] of [
        [paths.sourceOriginalPath, admittedSourcePath, paths.sourceCanonicalPath, PATH_ALIAS_POLICIES.strict],
        [paths.targetOriginalPath, admittedTargetPath, paths.targetCanonicalPath, PATH_ALIAS_POLICIES.unlinkTarget],
      ] as const) {
        if (original === undefined || expected === undefined) continue;
        for (const absolutePath of new Set([path.isAbsolute(original) ? original : `${root.rootWithSep}${original}`, selected])) {
          const current = resolveRootPathSync({ absolutePath, rootPath: root.rootReal,
            rootCanonicalPath: root.rootReal, rootIdentity: root.rootIdentity, boundaryLabel: "root", policy,
            ...mutationSymlinkResolution(params.mutationSymlinks) });
          if (current.canonicalPath !== expected) throw new FsSafeError("path-mismatch", "move route changed during authorization");
        }
      }
    }
    if (sourceStat !== undefined) {
      inspectFileIdentitySync(() => admitMoveSourceStat(fsSync.lstatSync(admittedSourcePath, { bigint: true }), overwrite), sourceStat);
    }
    try {
      assertFinalSymlinkRejected(admittedTargetPath, params.mutationSymlinks !== undefined);
      if (overwrite) binding.renameReplaceWithIdentity!(sourceParent.fd, path.basename(paths.sourcePath),
        targetParent.fd, path.basename(paths.targetPath), sourceStat!.dev, sourceStat!.ino);
      else binding.renameNoReplace(
        sourceParent.fd,
        path.basename(paths.sourcePath),
        targetParent.fd,
        path.basename(paths.targetPath),
      );
    } catch (error) {
      if (isAlreadyExistsError(error) || (!overwrite && (error as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY")) {
        throw new FsSafeError("already-exists", "destination exists", errorCauseOptions(error));
      }
      throw overwrite ? normalizeMoveError(error) : normalizeRenameNoReplaceError(error);
    }
    try {
      for (const admission of parentAdmissions) await assertAsyncDirectoryGuard(admission.guard);
      if (overwrite) inspectFileIdentitySync(() => fsSync.lstatSync(admittedTargetPath, { bigint: true }), sourceStat!);
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
      admission.close();
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
