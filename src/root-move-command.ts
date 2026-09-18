import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertSyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { isNotFoundPathError } from "./path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import type { NoReplaceMoveOptions, NoReplaceMovePaths } from "./root-move-portable.js";
import { resolveRootPathSync } from "./root-path.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

type Identity = Pick<BigIntStats, "dev" | "ino">;
type Parent = {
  parentFd: number;
  parentPath: string;
  parentRelativePath: string;
  parentIdentity: Identity;
  basename: string;
};

export type RootMoveCommandInput = {
  root: { path: string; identity: RootContext["rootIdentity"] };
  source: Parent & { identity: Identity };
  target: Parent;
};

function inspectSource(source: string, expected?: Identity): BigIntStats {
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

export async function movePathNoReplaceWithCommand(params: {
  root: RootContext;
  options: NoReplaceMoveOptions;
  paths: NoReplaceMovePaths;
  sourceParent: AsyncDirectoryGuard<BigIntStats>;
  targetParent: AsyncDirectoryGuard<BigIntStats>;
  mutationHookRan: boolean;
  command: (input: RootMoveCommandInput) => void;
  feature: string;
}): Promise<void> {
  const { root, options, paths, sourceParent, targetParent } = params;
  warnNativeFallback(params.feature, "A system command performs an atomic no-replace rename without file-content access. Command startup adds overhead; final pathname checks cannot eliminate swap races.");
  const parents = targetParent === sourceParent ? [sourceParent] : [sourceParent, targetParent];
  const descriptors = new Map<AsyncDirectoryGuard<BigIntStats>, number>();
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
  };
  const assertParents = () => {
    assertPaths();
    for (const [parent, fd] of descriptors) {
      inspectFileIdentitySync(() => {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isDirectory()) throw new FsSafeError("path-mismatch", "move parent descriptor changed");
        return stat;
      }, parent.stat);
    }
  };
  const admit = (parent: AsyncDirectoryGuard<BigIntStats>, name: string) => {
    const admitted = admitPathInsideRoot({
      rootPath: root.rootReal, rootIdentity: root.rootIdentity,
      candidatePath: path.join(parent.realPath, name),
    });
    if (!admitted) throw outsideWorkspaceError();
    return admitted.path;
  };
  const source = admit(sourceParent, path.basename(paths.sourcePath));
  const target = admit(targetParent, path.basename(paths.targetPath));
  let identity: BigIntStats | undefined;
  let failed = false;
  let operationError: unknown;
  let committed = false;
  const settledError = (error: unknown) => committed
    ? new FsSafeError(error instanceof FsSafeError ? error.code : "helper-failed", "atomic move command failed after source retirement", {
      cause: error,
      details: { ...(error instanceof FsSafeError ? error.details : {}), commit: "committed", sourceConsumed: true },
    }) : error;
  try {
    assertPaths();
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    for (const parent of parents) {
      try {
        descriptors.set(parent, fs.openSync(parent.realPath, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | noFollow));
      } catch (error) {
        throw isNotFoundPathError(error) ? fileNotFoundError(error) : error;
      }
      assertParents();
    }
    if (!params.mutationHookRan) await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", paths.targetPath);
    if (options.denyMutations) {
      await assertMutationNotDenied(source, options.denyMutations, { protectAncestors: true });
      await assertMutationNotDenied(target, options.denyMutations, { protectAncestors: true });
    }
    assertParents();
    // Match native rename admission: all awaited hooks/policy settle before
    // selecting the source. This route retains parents, not a readable file fd.
    identity = inspectSource(source);
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined);
    options.assertBeforeMutation?.();
    assertParents();
    inspectSource(source, identity);
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined);
    const commandParent = (parent: AsyncDirectoryGuard<BigIntStats>, basename: string): Parent => ({
      parentFd: descriptors.get(parent)!, parentPath: parent.realPath,
      parentRelativePath: path.relative(root.rootReal, parent.realPath),
      parentIdentity: { dev: parent.stat.dev, ino: parent.stat.ino }, basename,
    });
    try {
      params.command({
        root: { path: root.rootReal, identity: { ...root.rootIdentity } },
        source: { ...commandParent(sourceParent, path.basename(source)), identity: { dev: identity.dev, ino: identity.ino } },
        target: commandParent(targetParent, path.basename(target)),
      });
      committed = true;
    } catch (error) {
      // Only the command adapter can attest a commit before returning.
      if (error instanceof FsSafeError && error.details?.commit === "committed") committed = true;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST" || code === "ENOTEMPTY") throw new FsSafeError("already-exists", "destination exists", { cause: error });
      throw isNotFoundPathError(error) ? fileNotFoundError(error) : error;
    }
    assertParents();
    inspectSource(target, identity);
  } catch (error) {
    failed = true;
    operationError = settledError(error);
  }
  const closeErrors: unknown[] = [];
  for (const fd of new Set(descriptors.values())) {
    try { fs.closeSync(fd); } catch (error) { closeErrors.push(error); }
  }
  if (closeErrors.length) {
    const closing = settledError(closeErrors.length === 1 ? closeErrors[0] : new AggregateError(closeErrors, "move parent closes failed"));
    if (failed) throw createSuppressedError(closing, operationError, "atomic move command and descriptor close failed");
    throw closing;
  }
  if (failed) throw operationError;
  try {
    assertPaths();
    inspectSource(target, identity);
  } catch (error) { throw settledError(error); }
}
