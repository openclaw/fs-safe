import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { publishFileExclusive } from "./publish-file.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { serializePathWrite } from "./write-queue.js";

export type DurableQueueEntryPathsLike = {
  jsonPath: string;
  deliveredPath: string;
  processingPath?: string;
};

function getErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}

export function durableQueueProcessingPath(paths: DurableQueueEntryPathsLike): string {
  if (paths.processingPath) return paths.processingPath;
  return paths.jsonPath.endsWith(".json")
    ? `${paths.jsonPath.slice(0, -".json".length)}.processing`
    : `${paths.jsonPath}.processing`;
}

async function regularQueueFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`queue entry is not a regular file: ${filePath}`);
    }
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function unlinkIfCurrent(filePath: string, expected: Awaited<ReturnType<typeof fs.lstat>>): Promise<void> {
  const current = await fs.lstat(filePath, { bigint: true }).catch((error) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (!current) return;
  if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(current, expected)) {
    throw new FsSafeError("path-mismatch", "queue entry changed during ownership transfer");
  }
  await fs.unlink(filePath);
  await syncDirectoryBestEffort(path.dirname(filePath));
}

export async function claimDurableQueueEntry(
  paths: DurableQueueEntryPathsLike,
): Promise<string | null> {
  const processingPath = durableQueueProcessingPath(paths);
  return await serializePathWrite(paths.jsonPath, async () => {
    if (await regularQueueFileExists(processingPath)) return processingPath;
    let sourceIdentity: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      sourceIdentity = await fs.lstat(paths.jsonPath, { bigint: true });
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    if (
      sourceIdentity.isSymbolicLink() ||
      !sourceIdentity.isFile() ||
      sourceIdentity.nlink > 1n
    ) {
      return null;
    }
    await getFsSafeTestHooks()?.beforeDurableQueueClaimPublish?.(
      paths.jsonPath,
      processingPath,
    );
    try {
      await publishFileExclusive({
        sourcePath: paths.jsonPath,
        targetPath: processingPath,
        expectedSourceIdentity: sourceIdentity,
        strategy: "link-or-copy",
      });
    } catch (error) {
      if (
        getErrorCode(error) === "EEXIST" ||
        (error instanceof FsSafeError && error.code === "already-exists")
      ) {
        if (await regularQueueFileExists(processingPath)) return processingPath;
      }
      throw error;
    }
    await unlinkIfCurrent(paths.jsonPath, sourceIdentity);
    return processingPath;
  });
}

async function moveDurableQueueFileExclusive(sourcePath: string, targetPath: string): Promise<void> {
  await serializePathWrite(sourcePath, async () => {
    const sourceIdentity = await fs.lstat(sourcePath, { bigint: true });
    if (
      sourceIdentity.isSymbolicLink() ||
      !sourceIdentity.isFile() ||
      sourceIdentity.nlink > 1n
    ) {
      throw new Error("queue entry is not an owned regular file");
    }
    await publishFileExclusive({
      sourcePath,
      targetPath,
      expectedSourceIdentity: sourceIdentity,
      strategy: "link-or-copy",
    });
    await unlinkIfCurrent(sourcePath, sourceIdentity);
  });
}

export async function acknowledgeDurableQueueEntry(
  paths: DurableQueueEntryPathsLike,
): Promise<void> {
  const sourcePath = await claimDurableQueueEntry(paths);
  if (!sourcePath) {
    await fs.unlink(paths.deliveredPath).catch(() => undefined);
    return;
  }
  await serializePathWrite(paths.deliveredPath, async () => {
    await fs.unlink(paths.deliveredPath).catch((error) => {
      if (getErrorCode(error) !== "ENOENT") throw error;
    });
    await moveDurableQueueFileExclusive(sourcePath, paths.deliveredPath);
    await fs.unlink(paths.deliveredPath);
    await syncDirectoryBestEffort(path.dirname(paths.deliveredPath));
  });
}

export async function moveDurableQueueEntryToFailed(params: {
  paths: DurableQueueEntryPathsLike;
  failedPath: string;
}): Promise<void> {
  const processingPath = durableQueueProcessingPath(params.paths);
  const sourcePath = (await regularQueueFileExists(processingPath))
    ? processingPath
    : params.paths.jsonPath;
  await moveDurableQueueFileExclusive(sourcePath, params.failedPath);
}
