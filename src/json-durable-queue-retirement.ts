import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";

const RETIREMENT_ROOT_NAME = ".fs-safe-retirements";
const RETIREMENT_ENTRY_NAME = "entry";

function getErrorCode(error: unknown): string | null {
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
  let created = false;
  await fs.mkdir(rootPath, { mode: 0o700 }).then(
    () => {
      created = true;
    },
    (error) => {
      if (getErrorCode(error) !== "EEXIST") throw error;
    },
  );
  const root = await fs.lstat(rootPath, { bigint: true });
  assertDirectory(root, "queue retirement root");
  if (created) await syncDirectoryBestEffort(parentPath);
  return rootPath;
}

async function removeRetirementRecord(params: {
  dirPath: string;
  rootPath: string;
}): Promise<void> {
  await fs.rmdir(params.dirPath).catch((error) => {
    if (getErrorCode(error) !== "ENOENT") throw error;
  });
  await syncDirectoryBestEffort(params.rootPath);
}

export async function recoverDurableQueueRetirement(params: {
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
      await syncDirectoryBestEffort(path.dirname(params.jsonPath));
    } else if (
      !sameFileIdentityForCleanup(pending, entry) &&
      pending.nlink > 1n
    ) {
      throw new FsSafeError("path-mismatch", "queue replacement identity is ambiguous");
    }
  }
  await fs.unlink(entryPath);
  await syncDirectoryBestEffort(dirPath);
  await removeRetirementRecord({ dirPath, rootPath });
}

export async function retireDurableQueueSource(params: {
  jsonPath: string;
  processingPath: string;
}): Promise<void> {
  await recoverDurableQueueRetirement(params);
  const rootPath = await ensureRetirementRoot(params.jsonPath);
  const { dirPath, entryPath } = retirementPaths(params.jsonPath);
  await fs.mkdir(dirPath, { mode: 0o700 });
  await syncDirectoryBestEffort(rootPath);
  try {
    await fs.rename(params.jsonPath, entryPath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
    await removeRetirementRecord({ dirPath, rootPath });
    return;
  }
  await syncDirectoryBestEffort(path.dirname(params.jsonPath));
  await syncDirectoryBestEffort(dirPath);
  await recoverDurableQueueRetirement(params);
}
