import { randomUUID } from "node:crypto";
import syncFs, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RenameIdentityPolicy } from "./pinned-write-types.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { assertDestinationHardlinkPolicy, copyFallbackReplace } from "./replace-file-copy-fallback.js";
import { applyDirectoryMode, syncDirectoryBestEffort, writeTempFile } from "./replace-file-descriptor.js";
import { inheritedRegularFileMode } from "./replace-file-mode.js";
import {
  atomicExpectedContentHash,
  validateRenameIdentity,
  withAtomicRenameIdentityLock,
  withAtomicRenameIdentityLockSync,
} from "./replace-file-rename-policy.js";
import { AtomicTempOwner, type AtomicTempFailure } from "./replace-file-temp-owner.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { admitStandalonePublicationPath } from "./windows-path-alias.js";
import { serializePathWrite } from "./write-queue.js";
import { hasErrorCode, readErrorCode } from "./file-cleanup.js";
import { AtomicMutation } from "./replace-file-mutation.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { AtomicIo, runAsync, runSync, wait, type Procedure } from "./atomic-io.js";
import type {
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

function* renameWithRetry(
  io: AtomicIo,
  source: AtomicTempOwner,
  destination: string,
  options: ReplaceFileAtomicBaseOptions,
  mutation: AtomicMutation,
): Procedure<ReplaceFileAtomicResult> {
  const maxRetries = options.renameMaxRetries ?? 0;
  const baseDelayMs = options.renameRetryBaseDelayMs ?? 50;
  const copyFallbackOnPermissionError = options.copyFallbackOnPermissionError === true;
  const restore = options.copyFallbackRestore ?? "none";
  const maxRestoreBytes = options.maxRestoreBytes;
  const destinationHardlinks = options.destinationHardlinks;
  const sourceIdentity = source.identity;
  const sync = options.syncTempFile === true;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) yield* source.assertCurrent();
    try {
      mutation.assert();
      yield* io.rename(source.pathname, destination);
      return { method: "rename" };
    } catch (error) {
      mutation.rethrowRefusal();
      const code = readErrorCode(error);
      if (code === "EBUSY" && attempt < maxRetries) {
        yield* io.delay(baseDelayMs * 2 ** attempt);
        continue;
      }
      if (copyFallbackOnPermissionError && (code === "EPERM" || code === "EEXIST")) {
        yield* copyFallbackReplace(io, {
          src: source.pathname,
          dest: destination,
          destinationHardlinks,
          restore,
          maxRestoreBytes,
          expectedSourceIdentity: sourceIdentity,
          sync,
          mutation,
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

function* resolveMode(io: AtomicIo, options: ReplaceFileAtomicBaseOptions, filePath: string): Procedure<number> {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) return defaultMode;
  let stat: Stats | undefined;
  try {
    stat = yield* io.lstat(filePath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  return stat ? inheritedRegularFileMode(stat) : defaultMode;
}

export async function replaceFileAtomic(options: ReplaceFileAtomicOptions): Promise<ReplaceFileAtomicResult> {
  return await replaceFileAtomicWithDirectorySync(options);
}

// Directory durability remains inside the serialized publication and verification lifetime.
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
      return await replaceAsync(options, filePath, renameIdentity, mutation, syncParent);
    }
    const fsModule = options.fileSystem?.promises ?? fs;
    const dir = path.dirname(filePath);
    mutation.assert();
    await fsModule.mkdir(fsModule === fs ? recursiveMkdirPath(dir) : dir, {
      recursive: true,
      mode: options.dirMode ?? 0o700,
    });
    mutation.assert();
    return await withAtomicRenameIdentityLock(filePath, () =>
      replaceAsync(options, filePath, renameIdentity, mutation, syncParent));
  });
}

function replaceAsync(
  options: ReplaceFileAtomicOptions,
  filePath: string,
  renameIdentity: RenameIdentityPolicy | undefined,
  mutation: AtomicMutation,
  syncParent?: (directoryPath: string) => Promise<unknown>,
): Promise<ReplaceFileAtomicResult> {
  return runAsync(replace(AtomicIo.async(options.fileSystem?.promises ?? fs), options,
    filePath, renameIdentity, mutation, syncParent));
}

export function replaceFileAtomicSync(options: ReplaceFileAtomicSyncOptions): ReplaceFileAtomicResult {
  const mutation = new AtomicMutation(options);
  const filePath = validateReplaceFilePath(options.filePath);
  validateRestoreOptions(options);
  const renameIdentity = options.renameIdentity;
  validateRenameIdentity(renameIdentity);
  if (renameIdentity !== "verify-content-with-lock") {
    return replaceSync(options, filePath, renameIdentity, mutation);
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
    replaceSync(options, filePath, renameIdentity, mutation));
}

function replaceSync(
  options: ReplaceFileAtomicSyncOptions,
  filePath: string,
  renameIdentity: RenameIdentityPolicy | undefined,
  mutation: AtomicMutation,
): ReplaceFileAtomicResult {
  return runSync(replace(AtomicIo.sync(options.fileSystem ?? syncFs), options,
    filePath, renameIdentity, mutation));
}

function* replace(
  io: AtomicIo,
  options: ReplaceFileAtomicOptions | ReplaceFileAtomicSyncOptions,
  filePath: string,
  renameIdentity: RenameIdentityPolicy | undefined,
  mutation: AtomicMutation,
  syncParent?: (directoryPath: string) => Promise<unknown>,
): Procedure<ReplaceFileAtomicResult> {
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = yield* resolveMode(io, options, filePath);
  const expectedHash = atomicExpectedContentHash(renameIdentity, options.content);
  if (!io.asynchronous) {
    const syncOptions = options as ReplaceFileAtomicSyncOptions;
    io.fchmodSync = syncOptions.fileSystem?.fchmodSync ?? (
      syncOptions.fileSystem === undefined ? syncFs.fchmodSync : undefined
    );
    if (!io.fchmodSync && (options.mode !== undefined || options.preserveExistingMode === true ||
      (process.platform !== "win32" && options.dirMode !== undefined))) {
      throw new TypeError("fileSystem.fchmodSync is required when mode, dirMode, or preserveExistingMode is specified");
    }
  }
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const tempOwner = new AtomicTempOwner(tempPath, io);
  let originalFailure: AtomicTempFailure | undefined;
  try {
    mutation.assert();
    yield* io.mkdir(dir, dirMode);
    yield* applyDirectoryMode(io, { dirPath: dir, mode: dirMode, mutation });
    tempOwner.start();
    tempOwner.adopt(yield* writeTempFile(io, {
      tempPath,
      content: options.content,
      mode,
      sync: options.syncTempFile === true,
      onIdentity: tempOwner.onIdentity,
      mutation,
    }));
    yield* tempOwner.assertCurrent();
    if (options.beforeRename) {
      const result = options.beforeRename({ filePath, tempPath });
      if (io.asynchronous) yield* wait(result);
      else assertSynchronousCallbackResult(result, "beforeRename");
      yield* tempOwner.assertCurrent();
    }
    if (options.destinationHardlinks === "reject") {
      yield* assertDestinationHardlinkPolicy(io, filePath, options.destinationHardlinks);
      yield* tempOwner.assertCurrent();
    }
    const result = yield* renameWithRetry(io, tempOwner, filePath, options, mutation);
    if (result.method === "rename") {
      tempOwner.markRenamed();
      yield* tempOwner.assertPublished(filePath, expectedHash,
        identity => mutation.destination("published", filePath, identity));
    } else {
      yield* tempOwner.assertCurrent();
    }
    let didSyncParent = false;
    if (syncParent) {
      yield* wait(syncParent(dir));
      didSyncParent = true;
    } else if (options.syncParentDir) {
      yield* syncDirectoryBestEffort(io, dir);
      didSyncParent = true;
    }
    if (result.method === "rename" && didSyncParent) {
      yield* tempOwner.assertPublished(filePath, expectedHash);
    }
    return result;
  } catch (error) {
    originalFailure = { error };
    throw error;
  } finally {
    yield* tempOwner.finish({ originalFailure, throwOnCleanupError: options.throwOnCleanupError === true });
  }
}
