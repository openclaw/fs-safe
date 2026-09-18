import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { type PinnedDirectory, syncDirectoryBestEffortSync } from "./directory-durability.js";
import { assertSyncDirectoryGuard, createAsyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity, sameFileIdentityForCleanup } from "./file-identity.js";
import { syncFileBestEffortSync } from "./file-sync.js";
import type { NativeBinding } from "./native-binding.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { rememberCreatedTarget, type PublishFailureState } from "./publish-file-failure.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { retirePortableMoveSource } from "./portable-source-retirement.js";
import { isHardlinkCapabilityError, openLinuxRenameParentSync, renameLinuxNoReplaceSync } from "./linux-rename-command.js";
import { renameDarwinNoReplace } from "./darwin-move-command.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { moveWindowsFileNoReplaceSync } from "./windows-move-command.js";

type MoveParent = { handle: FileHandle; basename: string };
type MoveParams = {
  sourcePath: string;
  targetPath: string;
  source: { handle: FileHandle };
  sourceIdentity: BigIntStats;
  parent: PinnedDirectory;
  native?: NativeBinding;
  sourceNativeParent?: MoveParent;
  targetNativeParent?: MoveParent;
  failure: PublishFailureState;
};

const UNSUPPORTED_RENAME = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL"]);

function assertTarget(params: MoveParams, exact: boolean): void {
  const target = fsSync.lstatSync(params.targetPath, { bigint: true });
  const matches = exact ? sameFileIdentityForCleanup : sameFileIdentity;
  if (target.isSymbolicLink() || !target.isFile() || !matches(target, params.sourceIdentity)) {
    throw new FsSafeError("path-mismatch", "no-replace publication target changed");
  }
}

function openCommandParent(parent: AsyncDirectoryGuard<BigIntStats>): number {
  if (process.platform === "linux") return openLinuxRenameParentSync(parent.realPath, parent.stat);
  const access = nodeDirectorySearchOnlyFlags()?.flags ?? fsSync.constants.O_RDONLY;
  const fd = fsSync.openSync(parent.realPath, access | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW);
  try {
    inspectFileIdentitySync(() => {
      const stat = fsSync.fstatSync(fd, { bigint: true });
      if (!stat.isDirectory()) throw new FsSafeError("path-mismatch", "publication command parent changed");
      return stat;
    }, parent.stat);
    return fd;
  } catch (error) {
    try { fsSync.closeSync(fd); } catch (closeError) {
      throw createSuppressedError(closeError, error, "publication parent admission and close failed");
    }
    throw error;
  }
}

function moveByCommand(
  params: MoveParams,
  sourceParent: AsyncDirectoryGuard<BigIntStats>,
  targetParent: AsyncDirectoryGuard<BigIntStats>,
  assertSource: () => void,
): void {
  if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") {
    throw new FsSafeError("helper-unavailable", "atomic moving publication is unavailable on this platform", {
      details: { commit: "not-attempted" },
    });
  }
  warnNativeFallback("moving-file-atomic-publication", "A system command preserves atomic no-replace publication when hardlinks are unavailable; process startup adds overhead.");
  const descriptors: number[] = [];
  let failed = false;
  let operationError: unknown;
  let dispatched = false;
  try {
    if (process.platform === "win32") {
      assertSource();
      dispatched = true;
      moveWindowsFileNoReplaceSync({
        source: { parentPath: sourceParent.realPath, parentIdentity: sourceParent.stat,
          basename: path.basename(params.sourcePath), identity: params.sourceIdentity, expectedLinks: params.sourceIdentity.nlink },
        target: { parentPath: targetParent.realPath, parentIdentity: targetParent.stat, basename: path.basename(params.targetPath) },
      });
    } else {
      const sourceFd = openCommandParent(sourceParent);
      descriptors.push(sourceFd);
      const targetFd = sourceParent.realPath === targetParent.realPath ? sourceFd : openCommandParent(targetParent);
      if (targetFd !== sourceFd) descriptors.push(targetFd);
      assertSource();
      const source = { parentFd: sourceFd, basename: path.basename(params.sourcePath), parentIdentity: sourceParent.stat,
        identity: params.sourceIdentity, links: params.sourceIdentity.nlink, fd: params.source.handle.fd };
      const target = { parentFd: targetFd, basename: path.basename(params.targetPath), parentIdentity: targetParent.stat };
      dispatched = true;
      if (process.platform === "linux") renameLinuxNoReplaceSync({ source, target });
      else renameDarwinNoReplace({ source, target });
    }
    rememberCreatedTarget(params.failure, params.sourceIdentity, "rename-verify");
    params.failure.preserveTarget = true;
    params.failure.sourceConsumed = true;
  } catch (error) {
    const reported = error as { details?: { commit?: unknown }; commit?: unknown } | undefined;
    const commit = reported?.details?.commit ?? reported?.commit;
    if (commit === "committed") {
      rememberCreatedTarget(params.failure, params.sourceIdentity, "rename-verify");
      params.failure.preserveTarget = true;
      params.failure.sourceConsumed = true;
    } else if (dispatched && commit !== "not-attempted") {
      delete params.failure.sourceConsumed;
    }
    failed = true;
    operationError = error instanceof FsSafeError && error.code === "already-exists"
      ? Object.assign(new Error("publication target already exists", { cause: error }), { code: "EEXIST", commit })
      : error;
  }
  for (const fd of descriptors) {
    try { fsSync.closeSync(fd); } catch (closeError) {
      operationError = failed ? createSuppressedError(closeError, operationError, "publication command and parent close failed") : closeError;
      failed = true;
    }
  }
  if (failed) throw operationError;
}

async function moveByHardlink(params: MoveParams): Promise<"hardlink" | "rename-noreplace"> {
  const sourceParent = await createAsyncDirectoryGuard(path.dirname(params.sourcePath), { bigint: true });
  const targetParent = await createAsyncDirectoryGuard(path.dirname(params.targetPath), { bigint: true });
  await params.parent.assertCurrent();
  function assertSource(handle: FileHandle): void {
    assertSyncDirectoryGuard(sourceParent);
    assertSyncDirectoryGuard(targetParent);
    const opened = fsSync.fstatSync(handle.fd, { bigint: true });
    const current = fsSync.lstatSync(params.sourcePath, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || !opened.isFile() ||
      !sameFileIdentityForCleanup(opened, params.sourceIdentity) ||
      !sameFileIdentityForCleanup(current, opened)) {
      throw new FsSafeError("path-mismatch", "publication source changed during operation");
    }
  }
  assertSource(params.source.handle);
  try {
    fsSync.linkSync(params.sourcePath, params.targetPath);
  } catch (error) {
    if (!isHardlinkCapabilityError(error)) throw error;
    params.failure.phase = "rename-create";
    moveByCommand(params, sourceParent, targetParent, () => assertSource(params.source.handle));
    await getFsSafeTestHooks()?.afterPublishTargetCreated?.("rename-noreplace", params.targetPath, params.sourceIdentity);
    assertSyncDirectoryGuard(sourceParent);
    assertSyncDirectoryGuard(targetParent);
    assertTarget(params, true);
    return "rename-noreplace";
  }
  rememberCreatedTarget(params.failure, params.sourceIdentity, "hardlink-verify");
  // Once linked, either name may be the last one left by concurrent activity.
  params.failure.preserveTarget = true;
  params.failure.sourceConsumed = false;
  warnNativeFallback("moving file publication", "The destination is created exclusively, then the source is retired separately; pathname identity checks are best-effort and recovery artifacts can remain.");
  await getFsSafeTestHooks()?.afterPublishTargetCreated?.("hardlink", params.targetPath, params.sourceIdentity);
  let sibling: FileHandle | undefined;
  try {
    let source = params.source.handle;
    if (process.platform === "win32") {
      // Legacy Windows deletion waits on handles opened through the old name.
      sibling = await fs.open(params.targetPath, resolveReadOpenFlags());
      const opened = fsSync.fstatSync(sibling.fd, { bigint: true });
      if (!opened.isFile() || !sameFileIdentityForCleanup(opened, params.sourceIdentity)) {
        throw new FsSafeError("path-mismatch", "publication sibling handle changed");
      }
      assertSource(source);
      assertTarget(params, true);
      // Transfer ownership before closing; a failed close must not be retried.
      const previous = params.source.handle;
      params.source.handle = sibling;
      source = sibling;
      sibling = undefined;
      await previous.close();
    }
    assertSource(source);
    assertTarget(params, true);
    params.failure.phase = "source-remove";
    const assertParentsAndTarget = () => {
      assertSyncDirectoryGuard(sourceParent);
      assertSyncDirectoryGuard(targetParent);
      assertTarget(params, true);
    };
    retirePortableMoveSource({
      sourcePath: path.join(sourceParent.realPath, path.basename(params.sourcePath)),
      sourceParentPath: sourceParent.realPath,
      sourceParentIdentity: { dev: sourceParent.stat.dev, ino: sourceParent.stat.ino },
      sourceFd: source.fd,
      identity: params.sourceIdentity,
      expectedLinks: params.sourceIdentity.nlink + 1n,
      assertBeforeCapture: () => { assertSource(source); assertTarget(params, true); },
      assertCaptured: assertParentsAndTarget,
      assertAfterRetirement: assertParentsAndTarget,
      onState(state) {
        if (state.sourceConsumed === undefined) delete params.failure.sourceConsumed;
        else params.failure.sourceConsumed = state.sourceConsumed;
        if (state.sourceRecovery) params.failure.sourceRecovery = { ...state.sourceRecovery };
        else delete params.failure.sourceRecovery;
      },
    });
    params.failure.phase = "rename-verify";
  } finally {
    await sibling?.close();
  }
  return "hardlink";
}

export async function publishByMovingSource(params: MoveParams): Promise<{
  method: "hardlink" | "rename-noreplace";
  identity: Stats;
  sourceConsumed: true;
}> {
  let renamed = false;
  let method: "hardlink" | "rename-noreplace" = "rename-noreplace";
  if (params.native?.renameNoReplace && params.sourceNativeParent && params.targetNativeParent) {
    try {
      params.native.renameNoReplace(
        params.sourceNativeParent.handle.fd,
        params.sourceNativeParent.basename,
        params.targetNativeParent.handle.fd,
        params.targetNativeParent.basename,
      );
      renamed = true;
    } catch (error) {
      if (!UNSUPPORTED_RENAME.has((error as NodeJS.ErrnoException | undefined)?.code ?? "")) throw error;
    }
  }
  if (renamed) {
    rememberCreatedTarget(params.failure, params.sourceIdentity, "rename-verify");
    params.failure.preserveTarget = true;
    params.failure.sourceConsumed = true;
    await getFsSafeTestHooks()?.afterPublishTargetCreated?.("rename-noreplace", params.targetPath, params.sourceIdentity);
    assertTarget(params, false);
  } else {
    method = await moveByHardlink(params);
  }
  try {
    fsSync.lstatSync(params.sourcePath);
    throw new FsSafeError("path-mismatch", "no-replace publication source still exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (renamed) syncFileBestEffortSync(params.sourceNativeParent!.handle.fd);
  else syncDirectoryBestEffortSync(path.dirname(params.sourcePath));
  assertTarget(params, true);
  return { method, identity: fsSync.fstatSync(params.source.handle.fd), sourceConsumed: true };
}
