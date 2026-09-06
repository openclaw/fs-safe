import { randomUUID } from "node:crypto";
import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertDestinationHardlinkPolicy,
  assertDestinationHardlinkPolicySync,
  copyFallbackReplace,
  copyFallbackReplaceSync,
  type ReplaceFileAtomicRestoreCleanup,
  type ReplaceFileAtomicRestoreFailureDetails,
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
import {
  atomicExpectedContentHash,
  type RenameIdentityPolicy,
  validateRenameIdentity,
  withAtomicRenameIdentityLock,
  withAtomicRenameIdentityLockSync,
} from "./replace-file-rename-policy.js";
import { AsyncAtomicTempOwner, SyncAtomicTempOwner } from "./replace-file-temp-owner.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { sleep, sleepSync } from "./timing.js";
import { serializePathWrite } from "./write-queue.js";

export type ReplaceFileAtomicFileSystem = {
  promises: Pick<
    typeof fs,
    | "mkdir"
    | "writeFile"
    | "rename"
    | "copyFile"
    | "unlink"
    | "rm"
    | "open"
    | "stat"
    | "lstat"
  > & {
    /** @deprecated Accepted for adapter compatibility but never called. */
    chmod?: typeof fs.chmod;
  };
};

export type ReplaceFileAtomicSyncFileSystem = Pick<
  typeof syncFs,
  | "mkdirSync"
  | "readFileSync"
  | "writeFileSync"
  | "renameSync"
  | "copyFileSync"
  | "unlinkSync"
  | "rmSync"
  | "openSync"
  | "fsyncSync"
  | "closeSync"
  | "fstatSync"
  | "statSync"
  | "lstatSync"
  | "ftruncateSync"
  | "readSync"
  | "writeSync"
> & {
  /** @deprecated Accepted for adapter compatibility but never called. */
  chmodSync?: typeof syncFs.chmodSync;
  fchmodSync?: typeof syncFs.fchmodSync;
};

export type {
  RenameIdentityPolicy,
  ReplaceFileAtomicRestoreCleanup,
  ReplaceFileAtomicRestoreFailureDetails,
  ReplaceFileCopyFallbackRestorePolicy,
  ReplaceFileDestinationHardlinkPolicy,
};

type ReplaceFileAtomicBaseOptions = {
  filePath: string;
  content: string | Uint8Array;
  dirMode?: number;
  mode?: number;
  preserveExistingMode?: boolean;
  tempPrefix?: string;
  renameMaxRetries?: number;
  renameRetryBaseDelayMs?: number;
  copyFallbackOnPermissionError?: boolean;
  copyFallbackRestore?: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  /** Strict by default; locked content verification is an explicit FUSE compatibility policy. */
  renameIdentity?: RenameIdentityPolicy;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
  throwOnCleanupError?: boolean;
};

export type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicFileSystem;
  /** Runs while the exact staged file is retained; replacing or hardlinking it is rejected. */
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
};

export type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicSyncFileSystem;
  /** Runs while the exact staged file is retained; replacing or hardlinking it is rejected. */
  beforeRename?: (params: { filePath: string; tempPath: string }) => void;
};

export type ReplaceFileAtomicResult = {
  method: "rename" | "copy-fallback";
};

function isRetryableRenameError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EBUSY";
}

function isPermissionRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EEXIST";
}

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
}): Promise<ReplaceFileAtomicResult> {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    if (attempt > 0) await params.assertSourceCurrent();
    try {
      await params.fsModule.rename(params.src, params.dest);
      return { method: "rename" };
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < params.maxRetries) {
        await sleep(params.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (params.copyFallbackOnPermissionError && isPermissionRenameError(error)) {
        await copyFallbackReplace({
          fsModule: params.fsModule,
          src: params.src,
          dest: params.dest,
          destinationHardlinks: params.destinationHardlinks,
          restore: params.copyFallbackRestore,
          maxRestoreBytes: params.maxRestoreBytes,
          expectedSourceIdentity: params.sourceIdentity,
          sync: params.syncFallback,
        });
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function renameWithRetrySync(params: {
  fsModule: ReplaceFileAtomicSyncFileSystem;
  src: string;
  dest: string;
  maxRetries: number;
  baseDelayMs: number;
  copyFallbackOnPermissionError: boolean;
  copyFallbackRestore: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  sourceIdentity: BigIntStats;
  assertSourceCurrent: () => void;
  fchmodSync?: SyncFchmod;
  syncFallback: boolean;
}): ReplaceFileAtomicResult {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    if (attempt > 0) params.assertSourceCurrent();
    try {
      params.fsModule.renameSync(params.src, params.dest);
      return { method: "rename" };
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < params.maxRetries) {
        sleepSync(params.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (params.copyFallbackOnPermissionError && isPermissionRenameError(error)) {
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
        });
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function validateReplaceFilePath(filePath: string): void {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("Atomic replace file path must be non-empty.");
  }
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

async function resolveMode(options: ReplaceFileAtomicOptions): Promise<number> {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  const stat = await (options.fileSystem?.promises ?? fs).stat(options.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  return stat ? stat.mode : defaultMode;
}

function resolveModeSync(options: ReplaceFileAtomicSyncOptions): number {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  const fsModule = options.fileSystem ?? syncFs;
  let stat: Stats | undefined;
  try {
    stat = fsModule.statSync(options.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return stat ? stat.mode : defaultMode;
}

function missingFchmodSyncError(): TypeError {
  return new TypeError(
    "fileSystem.fchmodSync is required when mode, dirMode, or preserveExistingMode is specified",
  );
}

export async function replaceFileAtomic(
  options: ReplaceFileAtomicOptions,
): Promise<ReplaceFileAtomicResult> {
  return await replaceFileAtomicWithDirectorySync(options);
}

// Internal owner hook: keep directory durability inside publication verification and serialization.
export async function replaceFileAtomicWithDirectorySync(
  options: ReplaceFileAtomicOptions,
  syncParent?: (directoryPath: string) => Promise<unknown>,
): Promise<ReplaceFileAtomicResult> {
  const filePath = options.filePath;
  validateReplaceFilePath(filePath);
  validateRestoreOptions(options);
  validateRenameIdentity(options.renameIdentity);
  return await serializePathWrite(path.resolve(filePath), async () => {
    if (options.renameIdentity !== "verify-content-with-lock") {
      return await replaceFileAtomicUnserialized(options, syncParent);
    }
    await (options.fileSystem?.promises ?? fs).mkdir(path.dirname(filePath), {
      recursive: true,
      mode: options.dirMode ?? 0o700,
    });
    return await withAtomicRenameIdentityLock(filePath, async () =>
      await replaceFileAtomicUnserialized(options, syncParent));
  });
}

async function replaceFileAtomicUnserialized(
  options: ReplaceFileAtomicOptions,
  syncParent?: (directoryPath: string) => Promise<unknown>,
): Promise<ReplaceFileAtomicResult> {
  const filePath = options.filePath;
  const fsModule = options.fileSystem?.promises ?? fs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = await resolveMode(options);
  const expectedHash = atomicExpectedContentHash(options.renameIdentity, options.content);
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const tempOwner = new AsyncAtomicTempOwner(tempPath);
  let originalError: unknown;
  try {
    await fsModule.mkdir(dir, { recursive: true, mode: dirMode });
    await applyDirectoryMode({ fsModule, dirPath: dir, mode: dirMode });
    tempOwner.start();
    tempOwner.adopt(await writeTempFile({
      fsModule,
      tempPath,
      content: options.content,
      mode,
      sync: options.syncTempFile === true,
      onIdentity: tempOwner.onIdentity,
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
    });
    if (result.method === "rename") {
      tempOwner.markRenamed();
      await tempOwner.assertPublished(fsModule, filePath, expectedHash);
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
    originalError = error;
    throw error;
  } finally {
    await tempOwner.finish({
      fsModule,
      originalError,
      throwOnCleanupError: options.throwOnCleanupError === true,
    });
  }
}

export function replaceFileAtomicSync(
  options: ReplaceFileAtomicSyncOptions,
): ReplaceFileAtomicResult {
  const filePath = options.filePath;
  validateReplaceFilePath(filePath);
  validateRestoreOptions(options);
  validateRenameIdentity(options.renameIdentity);
  if (options.renameIdentity !== "verify-content-with-lock") {
    return replaceFileAtomicSyncUnserialized(options);
  }
  (options.fileSystem ?? syncFs).mkdirSync(path.dirname(filePath), {
    recursive: true,
    mode: options.dirMode ?? 0o700,
  });
  return withAtomicRenameIdentityLockSync(filePath, () =>
    replaceFileAtomicSyncUnserialized(options));
}

function replaceFileAtomicSyncUnserialized(
  options: ReplaceFileAtomicSyncOptions,
): ReplaceFileAtomicResult {
  const filePath = options.filePath;
  const fsModule = options.fileSystem ?? syncFs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = resolveModeSync(options);
  const expectedHash = atomicExpectedContentHash(options.renameIdentity, options.content);
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
  let originalError: unknown;
  try {
    fsModule.mkdirSync(dir, { recursive: true, mode: dirMode });
    applyDirectoryModeSync({ fsModule, dirPath: dir, mode: dirMode, fchmodSync });
    tempOwner.start();
    tempOwner.adopt(writeTempFileSync({
      fsModule,
      tempPath,
      content: options.content,
      mode,
      fchmodSync,
      sync: options.syncTempFile === true,
      onIdentity: tempOwner.onIdentity,
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
    });
    if (result.method === "rename") {
      tempOwner.markRenamed();
      tempOwner.assertPublished(fsModule, filePath, expectedHash);
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
    originalError = error;
    throw error;
  } finally {
    tempOwner.finish({
      fsModule,
      originalError,
      throwOnCleanupError: options.throwOnCleanupError === true,
    });
  }
}
