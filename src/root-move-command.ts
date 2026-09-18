import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { assertSyncDirectoryGuard, createAsyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import type { NoReplaceMoveOptions, NoReplaceMovePaths } from "./root-move-noreplace.js";
import { resolveRootPathSync } from "./root-path.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function inspectSource(source: string, expected?: BigIntStats): BigIntStats {
  try {
    return inspectFileIdentitySync(() => {
      const stat = fs.lstatSync(source, { bigint: true });
      if (stat.isSymbolicLink()) throw new FsSafeError("symlink", "symlink not allowed");
      if (stat.isDirectory()) throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
      if (!stat.isFile()) throw new FsSafeError("not-file", "move requires a regular file");
      if (stat.nlink !== 1n) throw hardlinkedPathNotAllowedError();
      return stat;
    }, expected);
  } catch (error) {
    throw isNotFoundPathError(error) ? fileNotFoundError(error) : error;
  }
}

function pinSource(source: string): number | undefined {
  // The Windows command retains its own exact metadata/delete handle.
  if (process.platform === "win32") return undefined;
  const flags = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const search = nodeDirectorySearchOnlyFlags();
  if (process.platform === "linux" && search?.proc) {
    return fs.openSync(source, search.flags | flags);
  }
  try {
    return fs.openSync(source, fs.constants.O_RDONLY | flags);
  } catch (error) {
    if (process.platform !== "darwin" || !permissionDenied(error)) throw error;
  }
  try {
    return fs.openSync(source, fs.constants.O_WRONLY | flags);
  } catch (error) {
    if (!permissionDenied(error)) throw error;
    // Darwin's native rename is also name-based. Parent custody and final
    // identity checks retain that guarantee when file mode denies all opens.
    return undefined;
  }
}

function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function admitMovePath(root: RootContext, parent: AsyncDirectoryGuard<BigIntStats>, source: string): string {
  const admitted = admitPathInsideRoot({
    rootPath: root.rootReal,
    rootIdentity: root.rootIdentity,
    candidatePath: path.join(parent.realPath, path.basename(source)),
  });
  if (!admitted) throw outsideWorkspaceError();
  return admitted.path;
}

export async function movePathNoReplaceWithCommand(
  root: RootContext,
  options: NoReplaceMoveOptions,
  paths: NoReplaceMovePaths,
): Promise<void> {
  const sourceParent = await createAsyncDirectoryGuard(paths.sourceParentPath, { bigint: true });
  const targetParent = paths.targetParentPath === paths.sourceParentPath
    ? sourceParent
    : await createAsyncDirectoryGuard(paths.targetParentPath, { bigint: true });
  const parents = sourceParent === targetParent ? [sourceParent] : [sourceParent, targetParent];
  const source = admitMovePath(root, sourceParent, paths.sourcePath);
  const target = admitMovePath(root, targetParent, paths.targetPath);
  const assertPaths = () => {
    assertRootIdentityCurrentSync(root);
    for (const parent of parents) assertSyncDirectoryGuard(parent);
    if (options.mutationSymlinks === "reject") {
      for (const absolutePath of [paths.sourcePath, paths.targetPath]) {
        resolveRootPathSync({
          absolutePath, rootPath: root.rootReal, rootCanonicalPath: root.rootReal,
          rootIdentity: root.rootIdentity, boundaryLabel: "root",
          rejectSymlinks: true, rejectFinalSymlink: true,
        });
      }
    }
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined);
  };
  await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", paths.targetPath);
  if (options.denyMutations) {
    await assertMutationNotDenied(source, options.denyMutations, { protectAncestors: true });
    await assertMutationNotDenied(target, options.denyMutations, { protectAncestors: true });
  }
  assertPaths();
  // Select once, after awaited policy/hook admission, and keep this receipt
  // across command loading and the final synchronous authority callback.
  const identity = inspectSource(source);
  let sourceFd: number | undefined;
  const state: { outcome: "not-attempted" | "committed" | "unknown" } = { outcome: "not-attempted" };
  const settledError = (error: unknown): unknown => state.outcome === "not-attempted" ? error
    : new FsSafeError(error instanceof FsSafeError ? error.code : "helper-failed", "atomic move command did not settle cleanly", {
      cause: error,
      details: {
        ...(error instanceof FsSafeError ? error.details : {}),
        commit: state.outcome,
        ...(state.outcome === "committed" ? { sourceConsumed: true } : {}),
      },
    });
  let failed = false;
  let operationError: unknown;
  try {
    sourceFd = pinSource(source);
    if (sourceFd !== undefined) {
      const opened = inspectFileIdentitySync(() => fs.fstatSync(sourceFd!, { bigint: true }), identity);
      if (!opened.isFile() || opened.nlink !== 1n) throw new FsSafeError("path-mismatch", "move source changed while opening");
    }
    inspectSource(source, identity);
    const { renameNoReplaceWithCommand } = await import("./atomic-rename-command.js");
    await renameNoReplaceWithCommand({
      source: { path: source, parent: sourceParent, identity, fd: sourceFd },
      target: { path: target, parent: targetParent },
      root: { path: root.rootReal, identity: root.rootIdentity },
      assertCurrent: () => { assertPaths(); inspectSource(source, identity); },
      assertBeforeMutation: options.assertBeforeMutation,
      onOutcome: outcome => { state.outcome = outcome; },
    });
    assertPaths();
  } catch (error) {
    failed = true;
    operationError = settledError(isNotFoundPathError(error) ? fileNotFoundError(error) : error);
  }
  if (sourceFd !== undefined) {
    try { fs.closeSync(sourceFd); } catch (error) {
      const closeError = settledError(error);
      if (failed) throw settledError(createSuppressedError(closeError, operationError, "atomic move and source close failed"));
      throw closeError;
    }
  }
  if (failed) throw operationError;
  try { assertPaths(); } catch (error) { throw settledError(error); }
}
