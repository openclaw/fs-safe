import { randomUUID } from "node:crypto";
import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RenameIdentityPolicy } from "./pinned-write-types.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import {
  assertDestinationHardlinkPolicy,
  assertDestinationHardlinkPolicySync,
  copyFallbackReplace,
  copyFallbackReplaceSync,
  type ReplaceFileCopyFallbackRestorePolicy,
  type ReplaceFileDestinationHardlinkPolicy,
} from "./replace-file-copy-fallback.js";
import {
  applyDirectoryMode,
  applyDirectoryModeSync,
  syncDirectoryBestEffort,
  syncDirectoryBestEffortSync,
  type SyncFchmod,
  writeTempFile,
  writeTempFileSync,
} from "./replace-file-descriptor.js";
import { inheritedRegularFileMode } from "./replace-file-mode.js";
import {
  atomicExpectedContentHash,
  validateRenameIdentity,
  withAtomicRenameIdentityLock,
  withAtomicRenameIdentityLockSync,
} from "./replace-file-rename-policy.js";
import { AsyncAtomicTempOwner, SyncAtomicTempOwner, type AtomicTempFailure } from "./replace-file-temp-owner.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { admitStandalonePublicationPath } from "./windows-path-alias.js";
import { sleep, sleepSync } from "./timing.js";
import { serializePathWrite } from "./write-queue.js";
import { hasErrorCode, readErrorCode } from "./file-cleanup.js";
import { AtomicMutation } from "./replace-file-mutation.js";
import type {
  ReplaceFileAtomicFileSystem,
  ReplaceFileAtomicSyncFileSystem,
  ReplaceFileAtomicBaseOptions,
  ReplaceFileAtomicOptions,
  ReplaceFileAtomicSyncOptions,
  ReplaceFileAtomicResult,
} from "./replace-file-types.js";
export type { ReplaceFileAtomicDestinationState } from "./replace-file-mutation.js";
export type {
  ReplaceFileAtomicFileSystem,
  ReplaceFileAtomicSyncFileSystem,
  ReplaceFileAtomicOptions,
  ReplaceFileAtomicSyncOptions,
  ReplaceFileAtomicResult,
} from "./replace-file-types.js";

async function renameWithRetry(params: {
  fsModule: ReplaceFileAtomicFileSystem["promises"];
  src: string;
  dest: string;
  maxRetries: number;
  baseDelayMs: number;
  copyFallbackOnPermissionError: boolean;
  copyFallbackRestore: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  sourceIdentity: BigIntStats;
  assertSourceCurrent: () => Promise<void>;
  syncFallback: boolean;
  mutation: AtomicMutation;
}): Promise<ReplaceFileAtomicResult> {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    if (attempt > 0) await params.assertSourceCurrent();
    try {
      params.mutation.assert();
      await params.fsModule.rename(params.src, params.dest);
      return { method: "rename" };
    } catch (error) {
      params.mutation.rethrowRefusal();
      const code = readErrorCode(error);
      if (code === "EBUSY" && attempt < params.maxRetries) {
        await sleep(params.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (params.copyFallbackOnPermissionError && (code === "EPERM" || code === "EEXIST")) {
        await copyFallbackReplace({
          fsModule: params.fsModule,
          src: params.src,
          dest: params.dest,
          destinationHardlinks: params.destinationHardlinks,
          restore: params.copyFallbackRestore,
          maxRestoreBytes: params.maxRestoreBytes,
          expectedSourceIdentity: params.sourceIdentity,
          sync: params.syncFallback,
          mutation: params.mutation,
        });
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function renameWithRetrySync(params: Omit<
  Parameters<typeof renameWithRetry>[0],
  "fsModule" | "assertSourceCurrent"
> & {
  fsModule: ReplaceFileAtomicSyncFileSystem;
  assertSourceCurrent: () => void;
  fchmodSync?: SyncFchmod;
}): ReplaceFileAtomicResult {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    if (attempt > 0) params.assertSourceCurrent();
    try {
      params.mutation.assert();
      params.fsModule.renameSync(params.src, params.dest);
      return { method: "rename" };
    } catch (error) {
      params.mutation.rethrowRefusal();
      const code = readErrorCode(error);
      if (code === "EBUSY" && attempt < params.maxRetries) {
        sleepSync(params.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (params.copyFallbackOnPermissionError && (code === "EPERM" || code === "EEXIST")) {
        copyFallbackReplaceSync({
          fsModule: params.fsModule,
          src: params.src,
          dest: params.dest,
          destinationHardlinks: params.destinationHardlinks,
          restore: params.copyFallbackRestore,
          maxRestoreBytes: params.maxRestoreBytes,
          expectedSourceIdentity: params.sourceIdentity,
          fchmodSync: params.fchmodSync,
          sync: params.syncFallback,
          mutation: params.mutation,
        });
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function validateReplaceFilePath(filePath: string): string {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("Atomic replace file path must be non-empty.");
  }
  return admitStandalonePublicationPath(
    filePath,
    "atomic replace path uses a Windows filesystem namespace alias",
  );
}

function validateRestoreOptions(options: ReplaceFileAtomicBaseOptions): void {
  if (options.copyFallbackRestore !== "restore-original") return;
  if (options.maxRestoreBytes === undefined) {
    throw new RangeError("maxRestoreBytes is required when copyFallbackRestore is restore-original");
  }
  if (!Number.isSafeInteger(options.maxRestoreBytes) || options.maxRestoreBytes < 0) {
    throw new RangeError("maxRestoreBytes must be a non-negative safe integer");
  }
}

function buildReplaceTempPath(filePath: string, tempPrefix?: string): string {
  const dir = path.dirname(filePath);
  const safePrefix = assertSafePathPrefix(tempPrefix ?? ".fs-safe-replace", { label: "atomic replace temp prefix" });
  return path.join(dir, `${safePrefix}.${process.pid}.${randomUUID()}.tmp`);
}

async function resolveMode(options: ReplaceFileAtomicOptions, filePath: string): Promise<number> {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  const fsModule = options.fileSystem?.promises ?? fs;
  let stat: import("node:fs").Stats | null;
  try {
    stat = fsModule === fs ? syncFs.lstatSync(filePath) : await fsModule.lstat(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return defaultMode;
    }
    throw error;
  }
  return stat ? inheritedRegularFileMode(stat) : defaultMode;
}

function resolveModeSync(options: ReplaceFileAtomicSyncOptions, filePath: string): number {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  const fsModule = options.fileSystem ?? syncFs;
  let stat: Stats | undefined;
  try {
    stat = fsModule.lstatSync(filePath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  return stat ? inheritedRegularFileMode(stat) : defaultMode;
}

function missingFchmodSyncError(): TypeError {
  return new TypeError("fileSystem.fchmodSync is required when mode, dirMode, or preserveExistingMode is specified");
}

export async function replaceFileAtomic(options: ReplaceFileAtomicOptions): Promise<ReplaceFileAtomicResult> {
  return await replaceFileAtomicWithDirectorySync(options);
}

// Internal owner hook: keep directory durability inside publication verification and serialization.
export async function replaceFileAtomicWithDirectorySync(
  options: ReplaceFileAtomicOptions,
  syncParent?: (directoryPath: string) => Promise<unknown>,
): Promise<ReplaceFileAtomicResult> {
  const mutation = new AtomicMutation(options);
  const filePath = validateReplaceFilePath(options.filePath);
  validateRestoreOptions(options);
  const renameIdentity = options.renameIdentity;
  validateRenameIdentity(renameIdentity);
  return await serializePathWrite(path.resolve(filePath), async () => {
    if (renameIdentity !== "verify-content-with-lock") {
      return await replaceFileAtomicUnserialized(options, filePath, renameIdentity, mutation, syncParent);
    }
    const fsModule = options.fileSystem?.promises ?? fs;
    const dir = path.dirname(filePath);
    mutation.assert();
    await fsModule.mkdir(fsModule === fs ? recursiveMkdirPath(dir) : dir, {
      recursive: true,
      mode: options.dirMode ?? 0o700,
    });
    mutation.assert();
    return await withAtomicRenameIdentityLock(filePath, async () =>
      await replaceFileAtomicUnserialized(options, filePath, renameIdentity, mutation, syncParent));
  });
}

async function replaceFileAtomicUnserialized(
  options: ReplaceFileAtomicOptions,
  filePath: string,
  renameIdentity: RenameIdentityPolicy | undefined,
  mutation: AtomicMutation,
  syncParent?: (directoryPath: string) => Promise<unknown>,
): Promise<ReplaceFileAtomicResult> {
  const fsModule = options.fileSystem?.promises ?? fs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = await resolveMode(options, filePath);
  const expectedHash = atomicExpectedContentHash(renameIdentity, options.content);
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const tempOwner = new AsyncAtomicTempOwner(tempPath);
  let originalFailure: AtomicTempFailure | undefined;
  try {
    mutation.assert();
    await fsModule.mkdir(fsModule === fs ? recursiveMkdirPath(dir) : dir, { recursive: true, mode: dirMode });
    await applyDirectoryMode({ fsModule, dirPath: dir, mode: dirMode, mutation });
    tempOwner.start();
    tempOwner.adopt(await writeTempFile({
      fsModule,
      tempPath,
      content: options.content,
      mode,
      sync: options.syncTempFile === true,
      onIdentity: tempOwner.onIdentity,
      mutation,
    }));
    await tempOwner.assertCurrent(fsModule);
    if (options.beforeRename) {
      await options.beforeRename({ filePath, tempPath });
      await tempOwner.assertCurrent(fsModule);
    }
    if (options.destinationHardlinks === "reject") {
      await assertDestinationHardlinkPolicy(fsModule, filePath, options.destinationHardlinks);
      await tempOwner.assertCurrent(fsModule);
    }
    const result = await renameWithRetry({
      fsModule,
      src: tempPath,
      dest: filePath,
      maxRetries: options.renameMaxRetries ?? 0,
      baseDelayMs: options.renameRetryBaseDelayMs ?? 50,
      copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,
      copyFallbackRestore: options.copyFallbackRestore ?? "none",
      maxRestoreBytes: options.maxRestoreBytes,
      destinationHardlinks: options.destinationHardlinks,
      sourceIdentity: tempOwner.identity,
      assertSourceCurrent: () => tempOwner.assertCurrent(fsModule),
      syncFallback: options.syncTempFile === true,
      mutation,
    });
    if (result.method === "rename") {
      tempOwner.markRenamed();
      await tempOwner.assertPublished(fsModule, filePath, expectedHash,
        identity => mutation.destination("published", filePath, identity));
    } else {
      await tempOwner.assertCurrent(fsModule);
    }
    let didSyncParent = false;
    if (syncParent) {
      await syncParent(dir);
      didSyncParent = true;
    } else if (options.syncParentDir) {
      await syncDirectoryBestEffort(fsModule, dir);
      didSyncParent = true;
    }
    if (result.method === "rename" && didSyncParent) {
      await tempOwner.assertPublished(fsModule, filePath, expectedHash);
    }
    return result;
  } catch (error) {
    originalFailure = { error };
    throw error;
  } finally {
    await tempOwner.finish({
      fsModule,
      originalFailure,
      throwOnCleanupError: options.throwOnCleanupError === true,
    });
  }
}

export function replaceFileAtomicSync(options: ReplaceFileAtomicSyncOptions): ReplaceFileAtomicResult {
  const mutation = new AtomicMutation(options);
  const filePath = validateReplaceFilePath(options.filePath);
  validateRestoreOptions(options);
  const renameIdentity = options.renameIdentity;
  validateRenameIdentity(renameIdentity);
  if (renameIdentity !== "verify-content-with-lock") {
    return replaceFileAtomicSyncUnserialized(options, filePath, renameIdentity, mutation);
  }
  const fsModule = options.fileSystem ?? syncFs;
  const dir = path.dirname(filePath);
  mutation.assert();
  fsModule.mkdirSync(fsModule === syncFs ? recursiveMkdirPath(dir) : dir, {
    recursive: true,
    mode: options.dirMode ?? 0o700,
  });
  mutation.assert();
  return withAtomicRenameIdentityLockSync(filePath, () =>
    replaceFileAtomicSyncUnserialized(options, filePath, renameIdentity, mutation));
}

function replaceFileAtomicSyncUnserialized(
  options: ReplaceFileAtomicSyncOptions,
  filePath: string,
  renameIdentity: RenameIdentityPolicy | undefined,
  mutation: AtomicMutation,
): ReplaceFileAtomicResult {
  const fsModule = options.fileSystem ?? syncFs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = resolveModeSync(options, filePath);
  const expectedHash = atomicExpectedContentHash(renameIdentity, options.content);
  const fchmodSync = options.fileSystem?.fchmodSync ?? (
    options.fileSystem === undefined ? syncFs.fchmodSync : undefined
  );
  if (
    !fchmodSync &&
    (options.mode !== undefined ||
      options.preserveExistingMode === true ||
      (process.platform !== "win32" && options.dirMode !== undefined))
  ) {
    throw missingFchmodSyncError();
  }
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const tempOwner = new SyncAtomicTempOwner(tempPath);
  let originalFailure: AtomicTempFailure | undefined;
  try {
    mutation.assert();
    fsModule.mkdirSync(fsModule === syncFs ? recursiveMkdirPath(dir) : dir, { recursive: true, mode: dirMode });
    applyDirectoryModeSync({ fsModule, dirPath: dir, mode: dirMode, fchmodSync, mutation });
    tempOwner.start();
    tempOwner.adopt(writeTempFileSync({
      fsModule,
      tempPath,
      content: options.content,
      mode,
      fchmodSync,
      sync: options.syncTempFile === true,
      onIdentity: tempOwner.onIdentity,
      mutation,
    }));
    tempOwner.assertCurrent(fsModule);
    if (options.beforeRename) {
      options.beforeRename({ filePath, tempPath });
      tempOwner.assertCurrent(fsModule);
    }
    if (options.destinationHardlinks === "reject") {
      assertDestinationHardlinkPolicySync(fsModule, filePath, options.destinationHardlinks);
      tempOwner.assertCurrent(fsModule);
    }
    const result = renameWithRetrySync({
      fsModule,
      src: tempPath,
      dest: filePath,
      maxRetries: options.renameMaxRetries ?? 0,
      baseDelayMs: options.renameRetryBaseDelayMs ?? 50,
      copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,
      copyFallbackRestore: options.copyFallbackRestore ?? "none",
      maxRestoreBytes: options.maxRestoreBytes,
      destinationHardlinks: options.destinationHardlinks,
      sourceIdentity: tempOwner.identity,
      assertSourceCurrent: () => tempOwner.assertCurrent(fsModule),
      fchmodSync,
      syncFallback: options.syncTempFile === true,
      mutation,
    });
    if (result.method === "rename") {
      tempOwner.markRenamed();
      tempOwner.assertPublished(fsModule, filePath, expectedHash,
        identity => mutation.destination("published", filePath, identity));
    } else {
      tempOwner.assertCurrent(fsModule);
    }
    let didSyncParent = false;
    if (options.syncParentDir) {
      syncDirectoryBestEffortSync(fsModule, dir);
      didSyncParent = true;
    }
    if (result.method === "rename" && didSyncParent) {
      tempOwner.assertPublished(fsModule, filePath, expectedHash);
    }
    return result;
  } catch (error) {
    originalFailure = { error };
    throw error;
  } finally {
    tempOwner.finish({
      fsModule,
      originalFailure,
      throwOnCleanupError: options.throwOnCleanupError === true,
    });
  }
}
