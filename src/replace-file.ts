import { randomUUID } from "node:crypto";
import syncFs from "node:fs";
import type { Stats } from "node:fs";
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
  type SyncFchmod,
  writeTempFile,
  writeTempFileSync,
} from "./replace-file-descriptor.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { serializePathWrite } from "./write-queue.js";

export type ReplaceFileAtomicFileSystem = {
  promises: Pick<
    typeof fs,
    | "mkdir"
    | "chmod"
    | "writeFile"
    | "rename"
    | "copyFile"
    | "unlink"
    | "rm"
    | "open"
    | "stat"
    | "lstat"
  >;
};

export type ReplaceFileAtomicSyncFileSystem = Pick<
  typeof syncFs,
  | "mkdirSync"
  | "chmodSync"
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
  fchmodSync?: typeof syncFs.fchmodSync;
};

export type {
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
  syncTempFile?: boolean;
  syncParentDir?: boolean;
  throwOnCleanupError?: boolean;
};

export type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicFileSystem;
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
};

export type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicSyncFileSystem;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
}): Promise<ReplaceFileAtomicResult> {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
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
        });
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  fchmodSync?: SyncFchmod;
}): ReplaceFileAtomicResult {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
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
          fchmodSync: params.fchmodSync,
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
    "fileSystem.fchmodSync is required when mode or preserveExistingMode is specified",
  );
}

async function syncDirectoryBestEffort(
  fsModule: ReplaceFileAtomicFileSystem["promises"],
  dirPath: string,
): Promise<void> {
  let handle: Awaited<ReturnType<ReplaceFileAtomicFileSystem["promises"]["open"]>> | undefined;
  try {
    handle = await fsModule.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectoryBestEffortSync(
  fsModule: ReplaceFileAtomicSyncFileSystem,
  dirPath: string,
): void {
  let fd: number | undefined;
  try {
    fd = fsModule.openSync(dirPath, "r");
    fsModule.fsyncSync(fd);
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    if (fd !== undefined) {
      try {
        fsModule.closeSync(fd);
      } catch {
        // Best-effort close after directory fsync.
      }
    }
  }
}

async function cleanupTempFile(params: {
  fsModule: ReplaceFileAtomicFileSystem["promises"];
  tempPath: string;
  originalError?: unknown;
  throwOnCleanupError: boolean;
}): Promise<void> {
  const cleanupError = await params.fsModule
    .rm(params.tempPath, { force: true })
    .catch((error) => error);
  if (cleanupError && params.throwOnCleanupError && params.originalError !== undefined) {
    throw new Error(
      `Atomic file replace failed (${String(params.originalError)}); cleanup also failed (${String(cleanupError)})`,
      { cause: params.originalError },
    );
  }
}

export async function replaceFileAtomic(
  options: ReplaceFileAtomicOptions,
): Promise<ReplaceFileAtomicResult> {
  const filePath = options.filePath;
  validateReplaceFilePath(filePath);
  validateRestoreOptions(options);
  return await serializePathWrite(path.resolve(filePath), async () => {
    return await replaceFileAtomicUnserialized(options);
  });
}

async function replaceFileAtomicUnserialized(
  options: ReplaceFileAtomicOptions,
): Promise<ReplaceFileAtomicResult> {
  const filePath = options.filePath;
  const fsModule = options.fileSystem?.promises ?? fs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = await resolveMode(options);
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const unregisterTempPath = registerTempPathForExit(tempPath);
  let tempExists = false;
  let originalError: unknown;
  await fsModule.mkdir(dir, { recursive: true, mode: dirMode });
  await fsModule.chmod(dir, dirMode).catch(() => undefined);
  try {
    tempExists = true;
    unregisterTempPath.setIdentity(await writeTempFile({
      fsModule,
      tempPath,
      content: options.content,
      mode,
      sync: options.syncTempFile === true,
    }));
    if (options.beforeRename) {
      await options.beforeRename({ filePath, tempPath });
    }
    await assertDestinationHardlinkPolicy(fsModule, filePath, options.destinationHardlinks);
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
    });
    tempExists = false;
    unregisterTempPath();
    if (options.syncParentDir) {
      await syncDirectoryBestEffort(fsModule, dir);
    }
    return result;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    if (tempExists) {
      await cleanupTempFile({
        fsModule,
        tempPath,
        originalError,
        throwOnCleanupError: options.throwOnCleanupError === true,
      });
    }
    unregisterTempPath();
  }
}

export function replaceFileAtomicSync(
  options: ReplaceFileAtomicSyncOptions,
): ReplaceFileAtomicResult {
  const filePath = options.filePath;
  validateReplaceFilePath(filePath);
  validateRestoreOptions(options);
  const fsModule = options.fileSystem ?? syncFs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = resolveModeSync(options);
  const fchmodSync = options.fileSystem?.fchmodSync ?? (
    options.fileSystem === undefined ? syncFs.fchmodSync : undefined
  );
  if (!fchmodSync && (options.mode !== undefined || options.preserveExistingMode === true)) {
    throw missingFchmodSyncError();
  }
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const unregisterTempPath = registerTempPathForExit(tempPath);
  let tempExists = false;
  let originalError: unknown;
  fsModule.mkdirSync(dir, { recursive: true, mode: dirMode });
  try {
    fsModule.chmodSync(dir, dirMode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
  try {
    tempExists = true;
    unregisterTempPath.setIdentity(writeTempFileSync({
      fsModule,
      tempPath,
      content: options.content,
      mode,
      fchmodSync,
      sync: options.syncTempFile === true,
    }));
    if (options.beforeRename) {
      options.beforeRename({ filePath, tempPath });
    }
    assertDestinationHardlinkPolicySync(fsModule, filePath, options.destinationHardlinks);
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
      fchmodSync,
    });
    tempExists = false;
    unregisterTempPath();
    if (options.syncParentDir) {
      syncDirectoryBestEffortSync(fsModule, dir);
    }
    return result;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    if (tempExists) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch (cleanupError) {
        if (options.throwOnCleanupError && originalError !== undefined) {
          throw new Error(
            `Atomic file replace failed (${String(originalError)}); cleanup also failed (${String(cleanupError)})`,
            { cause: originalError },
          );
        }
        // The temp file is best-effort cleanup after write failure.
      }
    }
    unregisterTempPath();
  }
}
