import { randomUUID } from "node:crypto";
import { withSidecarLock } from "./sidecar-lock.js";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import { serializePathWrite } from "./write-queue.js";

export type DurableQueueEntryPathsLike = {
  jsonPath: string;
  deliveredPath: string;
  processingPath?: string;
};

export function durableQueueProcessingPath(paths: DurableQueueEntryPathsLike): string {
  if (paths.processingPath) return paths.processingPath;
  return paths.jsonPath.endsWith(".json")
    ? `${paths.jsonPath.slice(0, -".json".length)}.processing`
    : `${paths.jsonPath}.processing`;
}

async function regularQueueFileIdentity(filePath: string): Promise<BigIntStats | null> {
  const identity = await lstatOrNull(filePath);
  if (!identity) return null;
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw new Error(`queue entry is not a regular file: ${filePath}`);
  }
  return identity;
}

async function withQueueEntryLock<T>(
  paths: DurableQueueEntryPathsLike,
  run: () => Promise<T>,
): Promise<T> {
  return await serializePathWrite(paths.jsonPath, async () =>
    await withQueueTransferLock(path.resolve(paths.jsonPath), run));
}

async function claimDurableQueueEntryUnlocked(
  paths: DurableQueueEntryPathsLike,
  options: { skipUnowned?: boolean } = {},
): Promise<string | null> {
  const processingPath = durableQueueProcessingPath(paths);
  await recoverDurableQueueRetirement({ jsonPath: paths.jsonPath, processingPath });
  const existingProcessing = await regularQueueFileIdentity(processingPath);
  if (existingProcessing) {
    const pending = await lstatOrNull(paths.jsonPath);
    if (
      pending &&
      !pending.isSymbolicLink() &&
      pending.isFile() &&
      sameFileIdentityForCleanup(pending, existingProcessing)
    ) {
      await retireDurableQueueSource({ jsonPath: paths.jsonPath, processingPath });
    }
    return processingPath;
  }
  const pending = await lstatOrNull(paths.jsonPath);
  if (!pending || pending.isSymbolicLink() || !pending.isFile()) return null;
  if (pending.nlink > 1n || !sameFileIdentityForCleanup(pending, pending)) {
    // Batch admission may skip unowned input, never a failed owned transition.
    if (options.skipUnowned) return null;
    throw new FsSafeError("path-mismatch", "queue entry is not exclusively owned");
  }
  try {
    await fs.link(paths.jsonPath, processingPath);
  } catch (error) {
    if (getErrorCode(error) === "EEXIST") {
      return (await regularQueueFileIdentity(processingPath)) ? processingPath : null;
    }
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  await syncDirectory(path.dirname(processingPath));
  const claimed = await regularQueueFileIdentity(processingPath);
  if (!claimed || claimed.nlink > 2n) {
    throw new FsSafeError("path-mismatch", "queue claim is not an owned regular file");
  }
  await retireDurableQueueSource({ jsonPath: paths.jsonPath, processingPath });
  return processingPath;
}

export async function claimDurableQueueEntry(
  paths: DurableQueueEntryPathsLike,
  options: { skipUnowned?: boolean } = {},
): Promise<string | null> {
  if (!(await lstatOrNull(path.dirname(paths.jsonPath)))) return null;
  return await withQueueEntryLock(paths, async () => await claimDurableQueueEntryUnlocked(paths, options));
}

export async function completeDeliveredQueueEntry(
  paths: DurableQueueEntryPathsLike,
): Promise<boolean> {
  if (!(await lstatOrNull(path.dirname(paths.deliveredPath)))) return false;
  return await withQueueEntryLock(paths, async () => {
    if (!(await regularQueueFileIdentity(paths.deliveredPath))) return false;
    if (await regularQueueFileIdentity(durableQueueProcessingPath(paths))) {
      await fs.unlink(paths.deliveredPath);
      await syncDirectory(path.dirname(paths.deliveredPath));
      return false;
    }
    await fs.unlink(paths.deliveredPath);
    await syncDirectory(path.dirname(paths.deliveredPath));
    return true;
  });
}

export async function acknowledgeDurableQueueEntry(
  paths: DurableQueueEntryPathsLike,
): Promise<void> {
  if (!(await lstatOrNull(path.dirname(paths.jsonPath)))) return;
  await withQueueEntryLock(paths, async () => {
    const processingPath = durableQueueProcessingPath(paths);
    const processing = await regularQueueFileIdentity(processingPath);
    const delivered = await regularQueueFileIdentity(paths.deliveredPath);
    if (!processing) {
      if (delivered) {
        await fs.unlink(paths.deliveredPath);
      }
      await syncDirectory(path.dirname(paths.deliveredPath));
      if (await regularQueueFileIdentity(paths.jsonPath)) {
        throw new FsSafeError(
          "path-mismatch",
          "queue acknowledgement requires a processing claim",
        );
      }
      return;
    }
    if (delivered) await fs.unlink(paths.deliveredPath);
    await fs.rename(processingPath, paths.deliveredPath);
    await syncDirectory(path.dirname(paths.deliveredPath));
    await fs.unlink(paths.deliveredPath);
    await syncDirectory(path.dirname(paths.deliveredPath));
  });
}

export async function moveDurableQueueEntryToFailed(params: {
  paths: DurableQueueEntryPathsLike;
  failedPath: string;
}): Promise<void> {
  await withQueueEntryLock(params.paths, async () => {
    const processingPath = durableQueueProcessingPath(params.paths);
    const processing = await regularQueueFileIdentity(processingPath);
    const existingFailed = await regularQueueFileIdentity(params.failedPath);
    if (!processing && existingFailed) {
      await syncDirectory(path.dirname(params.failedPath));
      await syncDirectory(path.dirname(processingPath));
      const recoveredFailed = await regularQueueFileIdentity(params.failedPath);
      if (
        !recoveredFailed ||
        !sameFileIdentityForCleanup(existingFailed, recoveredFailed)
      ) {
        throw new FsSafeError(
          "path-mismatch",
          "failed queue destination changed during recovery",
        );
      }
      if (await regularQueueFileIdentity(params.paths.jsonPath)) {
        throw new FsSafeError(
          "already-exists",
          "failed queue destination already exists",
        );
      }
      return;
    }

    const sourcePath = processing
      ? processingPath
      : await claimDurableQueueEntryUnlocked(params.paths);
    if (!sourcePath) {
      throw Object.assign(new Error("queue entry does not exist"), { code: "ENOENT" });
    }
    const source = await regularQueueFileIdentity(sourcePath);
    const failed = await regularQueueFileIdentity(params.failedPath);
    if (failed) {
      if (source && sameFileIdentityForCleanup(source, failed)) {
        await syncDirectory(path.dirname(params.failedPath));
        await fs.unlink(sourcePath);
        await syncDirectory(path.dirname(sourcePath));
        return;
      }
      throw new FsSafeError("already-exists", "failed queue destination already exists");
    }
    await fs.link(sourcePath, params.failedPath);
    await syncDirectory(path.dirname(params.failedPath));
    await fs.unlink(sourcePath);
    await syncDirectory(path.dirname(sourcePath));
  });
}

const RETIREMENT_ROOT_NAME = ".fs-safe-retirements";
const RETIREMENT_ENTRY_NAME = "entry";

export function getErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}

async function lstatOrNull(filePath: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertDirectory(identity: BigIntStats, label: string): void {
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new FsSafeError("path-mismatch", `${label} is not an owned directory`);
  }
}

async function regularFileIdentity(filePath: string): Promise<BigIntStats | null> {
  const identity = await lstatOrNull(filePath);
  if (!identity) return null;
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw new FsSafeError("path-mismatch", "queue retirement path is not a regular file");
  }
  return identity;
}

function retirementPaths(jsonPath: string): {
  dirPath: string;
  entryPath: string;
  rootPath: string;
} {
  const rootPath = path.join(path.dirname(jsonPath), RETIREMENT_ROOT_NAME);
  const dirPath = path.join(rootPath, path.basename(jsonPath));
  return { dirPath, entryPath: path.join(dirPath, RETIREMENT_ENTRY_NAME), rootPath };
}

async function inspectRetirementRoot(jsonPath: string): Promise<string | null> {
  const rootPath = retirementPaths(jsonPath).rootPath;
  const root = await lstatOrNull(rootPath);
  if (!root) return null;
  assertDirectory(root, "queue retirement root");
  return rootPath;
}

async function ensureRetirementRoot(jsonPath: string): Promise<string> {
  const parentPath = path.dirname(jsonPath);
  const rootPath = retirementPaths(jsonPath).rootPath;
  await fs.mkdir(rootPath, { mode: 0o700 }).catch((error) => {
    if (getErrorCode(error) !== "EEXIST") throw error;
  });
  const root = await fs.lstat(rootPath, { bigint: true });
  assertDirectory(root, "queue retirement root");
  await syncDirectory(parentPath);
  return rootPath;
}

async function removeRetirementRecord(params: {
  dirPath: string;
  rootPath: string;
}): Promise<void> {
  await fs.rmdir(params.dirPath).catch((error) => {
    if (getErrorCode(error) !== "ENOENT") throw error;
  });
  await syncDirectory(params.rootPath);
}

async function recoverDurableQueueRetirement(params: {
  jsonPath: string;
  processingPath: string;
}): Promise<void> {
  const rootPath = await inspectRetirementRoot(params.jsonPath);
  if (!rootPath) return;
  const { dirPath, entryPath } = retirementPaths(params.jsonPath);
  const dir = await lstatOrNull(dirPath);
  if (!dir) return;
  assertDirectory(dir, "queue retirement record");
  const names = await fs.readdir(dirPath);
  if (names.length === 0) {
    await removeRetirementRecord({ dirPath, rootPath });
    return;
  }
  if (names.length !== 1 || names[0] !== RETIREMENT_ENTRY_NAME) {
    throw new FsSafeError("path-mismatch", "queue retirement record is ambiguous");
  }
  const entry = await regularFileIdentity(entryPath);
  const processing = await regularFileIdentity(params.processingPath);
  if (!entry || !processing) {
    throw new FsSafeError("path-mismatch", "queue retirement ownership is incomplete");
  }

  if (!sameFileIdentityForCleanup(entry, processing)) {
    const pending = await regularFileIdentity(params.jsonPath);
    if (!pending) {
      await fs.link(entryPath, params.jsonPath);
      await syncDirectory(path.dirname(params.jsonPath));
    } else if (sameFileIdentityForCleanup(pending, entry)) {
      await syncDirectory(path.dirname(params.jsonPath));
    } else if (pending.nlink > 1n) {
      throw new FsSafeError("path-mismatch", "queue replacement identity is ambiguous");
    }
  }
  await fs.unlink(entryPath);
  await syncDirectory(dirPath);
  await removeRetirementRecord({ dirPath, rootPath });
}

async function retireDurableQueueSource(params: {
  jsonPath: string;
  processingPath: string;
}): Promise<void> {
  await recoverDurableQueueRetirement(params);
  const rootPath = await ensureRetirementRoot(params.jsonPath);
  const { dirPath, entryPath } = retirementPaths(params.jsonPath);
  await fs.mkdir(dirPath, { mode: 0o700 });
  await syncDirectory(rootPath);
  try {
    await fs.rename(params.jsonPath, entryPath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
    await removeRetirementRecord({ dirPath, rootPath });
    return;
  }
  await syncDirectory(dirPath);
  await syncDirectory(path.dirname(params.jsonPath));
  await recoverDurableQueueRetirement(params);
}

async function withQueueTransferLock<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(
    path.dirname(filePath),
    `.fs-safe-transfer-${sha256Hex(path.basename(filePath)).slice(0, 32)}.lock`,
  );
  return await withSidecarLock(
    filePath,
    {
      managerKey: "fs-safe.queue-transfer",
      lockPath,
      staleMs: 30_000,
      staleRecovery: "fail-closed",
      timeoutMs: 45_000,
      payload: () => ({
        ownerToken: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
      retry: { retries: 180, minTimeout: 25, maxTimeout: 250, factor: 1.1 },
    },
    run,
  );
}
