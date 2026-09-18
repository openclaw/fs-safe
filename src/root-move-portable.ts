import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertSyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { assertMutationNotDenied, type DenyMutationPolicy } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { isHardlinkCapabilityError, openLinuxRenameParentSync, renameLinuxNoReplaceSync } from "./linux-rename-command.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { isNotFoundPathError } from "./path.js";
import { retirePortableMoveSource, type SourceRetirementState } from "./portable-source-retirement.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError, isAlreadyExistsError, outsideWorkspaceError } from "./root-errors.js";
import { resolveRootPathSync } from "./root-path.js";
import { assertFinalSymlinkRejected, type MutationSymlinkPolicy } from "./root-symlink-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { renameDarwinNoReplace } from "./darwin-move-command.js";
import { movePathNoReplaceWithCommand } from "./root-move-command.js";
import { moveWindowsFileNoReplaceSync, moveWindowsMetadataNoReplaceSync } from "./windows-move-command.js";

export type NoReplaceMoveOptions = {
  assertBeforeMutation?: () => void;
  denyMutations?: DenyMutationPolicy;
  mutationSymlinks?: MutationSymlinkPolicy;
};

export type NoReplaceMovePaths = {
  sourcePath: string;
  sourceParentPath: string;
  targetPath: string;
  targetParentPath: string;
};

function changed(): FsSafeError {
  return new FsSafeError("path-mismatch", "file changed during portable move");
}

function inspectLinkedFile(inspect: () => BigIntStats, expected: BigIntStats, links: bigint): BigIntStats {
  return inspectFileIdentitySync(() => {
    const stat = inspect();
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== links) throw changed();
    return stat;
  }, expected);
}

function normalizeMoveError(error: unknown): unknown {
  if (isNotFoundPathError(error)) return fileNotFoundError(error instanceof Error ? error : undefined);
  if (isAlreadyExistsError(error)) {
    return new FsSafeError("already-exists", "destination exists", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

function openSourceForMove(source: string): number {
  if (process.platform === "linux") {
    // Linux O_PATH (asm-generic/fcntl.h) pins metadata without read/write access.
    // Node accepts native open flags even though it does not export O_PATH.
    return fs.openSync(source, 0x0020_0000 | (fs.constants.O_NOFOLLOW ?? 0));
  }
  const flags = resolveReadOpenFlags();
  try {
    return fs.openSync(source, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    // A write-only file can still be moved. This descriptor is only observed;
    // no truncate/create flag or byte write is involved.
    return fs.openSync(source, flags | fs.constants.O_WRONLY);
  }
}

async function admitMoveParent(parentPath: string) {
  try {
    return await createAsyncDirectoryGuard(parentPath, { bigint: true });
  } catch (error) {
    throw isNotFoundPathError(error) ? normalizeMoveError(error) : error;
  }
}

export async function movePathNoReplacePortable(
  root: RootContext,
  params: NoReplaceMoveOptions,
  paths: NoReplaceMovePaths,
  mutationHookRan = false,
): Promise<void> {
  const sourceParent = await admitMoveParent(paths.sourceParentPath);
  const targetParent = paths.sourceParentPath === paths.targetParentPath
    ? sourceParent
    : await admitMoveParent(paths.targetParentPath);
  const admit = (parent: string, name: string) => {
    const admitted = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: path.join(parent, name),
      rootIdentity: root.rootIdentity,
    });
    if (!admitted) throw outsideWorkspaceError();
    return admitted.path;
  };
  const source = admit(sourceParent.realPath, path.basename(paths.sourcePath));
  const target = admit(targetParent.realPath, path.basename(paths.targetPath));
  const assertParents = () => {
    assertRootIdentityCurrentSync(root);
    assertSyncDirectoryGuard(sourceParent);
    if (targetParent !== sourceParent) assertSyncDirectoryGuard(targetParent);
    if (params.mutationSymlinks === "reject") {
      for (const absolutePath of [paths.sourcePath, paths.targetPath]) {
        resolveRootPathSync({
          absolutePath, rootPath: root.rootReal, rootCanonicalPath: root.rootReal,
          rootIdentity: root.rootIdentity, boundaryLabel: "root",
          rejectSymlinks: true, rejectFinalSymlink: true,
        });
      }
    }
  };
  assertParents();
  let identity: BigIntStats;
  try {
    identity = inspectFileIdentitySync(() => {
      const stat = fs.lstatSync(source, { bigint: true });
      if (stat.isSymbolicLink()) throw new FsSafeError("symlink", "symlink not allowed");
      if (stat.isDirectory()) throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
      if (!stat.isFile()) throw new FsSafeError("not-file", "portable move requires a regular file");
      if (stat.nlink !== 1n) throw hardlinkedPathNotAllowedError();
      return stat;
    });
  } catch (error) {
    throw normalizeMoveError(error);
  }

  let fd: number | undefined;
  let failed = false;
  let operationError: unknown;
  let retirement: SourceRetirementState | undefined;
  const settledError = (error: unknown) => retirement?.sourceConsumed === true
    ? new FsSafeError(error instanceof FsSafeError ? error.code : "helper-failed", "portable move failed after source retirement", {
      cause: error, details: { ...(error instanceof FsSafeError ? error.details : {}), sourceConsumed: true },
    }) : error;
  try {
    // Retain the inode even if another process replaces either pathname.
    try {
      fd = openSourceForMove(source);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if ((process.platform === "darwin" || process.platform === "win32") && (code === "EACCES" || code === "EPERM")) {
        return await movePathNoReplaceWithCommand({
          root, options: params, paths, sourceParent, targetParent, mutationHookRan,
          command: process.platform === "darwin" ? renameDarwinNoReplace : moveWindowsMetadataNoReplaceSync,
          feature: process.platform === "darwin" ? "macOS atomic no-clobber move" : "Windows atomic no-clobber move",
        });
      }
      throw normalizeMoveError(error);
    }
    warnNativeFallback("No-clobber move", "An exclusive hardlink is followed by guarded source retirement; recovery names may remain after a failure. Parent checks cannot eliminate pathname races.");
    const descriptor = fd;
    const inspectSource = (links: bigint) => {
      const opened = inspectLinkedFile(() => fs.fstatSync(descriptor, { bigint: true }), identity, links);
      const named = inspectLinkedFile(() => fs.lstatSync(source, { bigint: true }), identity, links);
      // A caller's live permission change must settle before source retirement.
      if (process.platform === "win32" && (
        (opened.mode & 0o200n) !== (identity.mode & 0o200n) ||
        (named.mode & 0o200n) !== (identity.mode & 0o200n)
      )) throw changed();
    };
    const inspectTarget = (links: bigint) =>
      inspectLinkedFile(() => fs.lstatSync(target, { bigint: true }), identity, links);
    const renameWithoutHardlinks = async () => {
      warnNativeFallback("Atomic no-clobber move", "A system command publishes the original inode on filesystems without hardlinks. Command startup adds overhead.");
      const descriptors = new Map<typeof sourceParent, number>();
      let failed = false;
      let operationError: unknown;
      try {
        assertParents();
        inspectSource(1n);
        for (const parent of process.platform === "win32" ? [] : new Set([sourceParent, targetParent])) {
          if (process.platform === "linux") {
            descriptors.set(parent, openLinuxRenameParentSync(parent.realPath, parent.stat));
          } else {
            const fd = fs.openSync(parent.realPath, (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            descriptors.set(parent, fd);
            inspectFileIdentitySync(() => {
              const stat = fs.fstatSync(fd, { bigint: true });
              if (!stat.isDirectory()) throw changed();
              return stat;
            }, parent.stat);
          }
        }
        if (params.denyMutations) {
          await assertMutationNotDenied(source, params.denyMutations, { protectAncestors: true });
          await assertMutationNotDenied(target, params.denyMutations, { protectAncestors: true });
        }
        params.assertBeforeMutation?.();
        assertParents();
        inspectSource(1n);
        assertFinalSymlinkRejected(target, params.mutationSymlinks !== undefined);
        retirement = {};
        if (process.platform === "linux") {
          renameLinuxNoReplaceSync({
            source: { parentFd: descriptors.get(sourceParent)!, basename: path.basename(source), parentIdentity: sourceParent.stat, identity, links: 1n, fd: descriptor },
            target: { parentFd: descriptors.get(targetParent)!, basename: path.basename(target), parentIdentity: targetParent.stat },
          });
        } else if (process.platform === "darwin") {
          renameDarwinNoReplace({
            source: { parentFd: descriptors.get(sourceParent)!, basename: path.basename(source) },
            target: { parentFd: descriptors.get(targetParent)!, basename: path.basename(target) },
          });
        } else {
          moveWindowsFileNoReplaceSync({
            source: { parentPath: sourceParent.realPath, parentIdentity: sourceParent.stat, basename: path.basename(source), identity, expectedLinks: 1n },
            target: { parentPath: targetParent.realPath, parentIdentity: targetParent.stat, basename: path.basename(target) },
          });
        }
        retirement = { sourceConsumed: true };
        assertParents();
        inspectLinkedFile(() => fs.fstatSync(descriptor, { bigint: true }), identity, 1n);
        inspectTarget(1n);
      } catch (error) {
        failed = true;
        if (error instanceof FsSafeError && error.details?.commit === "committed") retirement = { sourceConsumed: true };
        operationError = settledError(normalizeMoveError(error));
      }
      const closeErrors: unknown[] = [];
      for (const fd of descriptors.values()) {
        try { fs.closeSync(fd); } catch (error) { closeErrors.push(error); }
      }
      if (closeErrors.length) {
        const closeError = settledError(closeErrors.length === 1 ? closeErrors[0] : new AggregateError(closeErrors, "atomic move parent closes failed"));
        if (failed) throw createSuppressedError(closeError, operationError, "atomic move and parent descriptor close failed");
        throw closeError;
      }
      if (failed) throw operationError;
    };
    inspectSource(1n);
    if (!mutationHookRan) await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", paths.targetPath);
    if (params.denyMutations) {
      await assertMutationNotDenied(source, params.denyMutations, { protectAncestors: true });
      await assertMutationNotDenied(target, params.denyMutations, { protectAncestors: true });
    }
    assertParents();
    inspectSource(1n);
    assertFinalSymlinkRejected(target, params.mutationSymlinks !== undefined);
    params.assertBeforeMutation?.();
    assertParents();
    inspectSource(1n);
    assertFinalSymlinkRejected(target, params.mutationSymlinks !== undefined);
    // link is exclusive even if a competing writer wins after the last check.
    let renamed = false;
    try {
      fs.linkSync(source, target);
    } catch (error) {
      if (!["linux", "darwin", "win32"].includes(process.platform) || !isHardlinkCapabilityError(error)) throw normalizeMoveError(error);
      await renameWithoutHardlinks();
      renamed = true;
    }
    if (!renamed) {
      assertParents();
      inspectSource(2n);
      inspectTarget(2n);
      retirePortableMoveSource({
        sourcePath: source, sourceParentPath: sourceParent.realPath, sourceParentIdentity: sourceParent.stat,
        sourceFd: descriptor, identity, expectedLinks: 2n,
        assertBeforeMutation: params.assertBeforeMutation,
        assertBeforeCapture: () => { assertParents(); inspectSource(2n); inspectTarget(2n); },
        assertCaptured: () => { assertParents(); inspectTarget(2n); },
        assertAfterRetirement: () => { assertParents(); inspectTarget(1n); },
        onState: state => { retirement = state; },
      });
    }
  } catch (error) {
    failed = true;
    operationError = error;
  }

  // A completed link is never rolled back: it may now be the inode's only name.
  // Consume the descriptor once, preserving operation and close failures.
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch (closeError) {
      if (failed) throw createSuppressedError(settledError(closeError), operationError, "portable move and descriptor close failed");
      throw settledError(closeError);
    }
  }
  if (failed) throw operationError;
  try {
    assertParents();
    const published = inspectLinkedFile(() => fs.lstatSync(target, { bigint: true }), identity, 1n);
    if (process.platform === "win32" && (published.mode & 0o777n) !== (identity.mode & 0o777n)) throw changed();
  } catch (error) { throw settledError(error); }
}
