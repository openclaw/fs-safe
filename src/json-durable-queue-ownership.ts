import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import {
  getErrorCode,
  lstatOrNull,
  recoverDurableQueueRetirement,
  retireDurableQueueSource,
} from "./json-durable-queue-retirement.js";
import { withQueueTransferLock } from "./json-durable-queue-transfer-lock.js";
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
