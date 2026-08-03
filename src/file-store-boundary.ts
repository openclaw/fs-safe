import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertSyncDirectoryGuard as assertDirectoryGuardSync,
  createSyncDirectoryGuard,
  type SyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isPathInside, isPathRelativeEscape } from "./path.js";
import { resolveOpenedFileRealPathForHandle, root, type Root } from "./root.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";

export type SyncParentGuard = SyncDirectoryGuard;

function parentRelativePath(relativePath: string): string {
  const parent = path.posix.dirname(relativePath);
  return parent === "." ? "" : parent;
}

export async function ensureParentInRoot(
  scopedRoot: Root,
  relativePath: string,
  mode: number,
): Promise<void> {
  const parent = parentRelativePath(relativePath);
  if (!parent) {
    return;
  }
  await scopedRoot.mkdir(parent);
  await chmodDirectoryInRootBestEffort(scopedRoot, parent, mode).catch(() => undefined);
}

export async function openWritableStoreRoot(params: {
  rootDir: string;
  dirMode: number;
  maxBytes?: number;
}): Promise<Root> {
  await fs.mkdir(params.rootDir, { recursive: true, mode: params.dirMode });
  await fs.chmod(params.rootDir, params.dirMode).catch(() => undefined);
  return await root(params.rootDir, { hardlinks: "reject", maxBytes: params.maxBytes });
}

async function chmodDirectoryInRootBestEffort(
  scopedRoot: Root,
  relativePath: string,
  mode: number,
): Promise<void> {
  const dirPath = await scopedRoot.resolve(relativePath);
  const directoryFlag = "O_DIRECTORY" in syncFs.constants ? syncFs.constants.O_DIRECTORY : 0;
  const noFollowFlag =
    process.platform !== "win32" && "O_NOFOLLOW" in syncFs.constants
      ? syncFs.constants.O_NOFOLLOW
      : 0;
  const handle = await fs.open(dirPath, syncFs.constants.O_RDONLY | directoryFlag | noFollowFlag);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      return;
    }
    const realPath = await resolveOpenedFileRealPathForHandle(handle, dirPath);
    if (!isPathInside(scopedRoot.rootWithSep, realPath)) {
      throw new FsSafeError("outside-workspace", "directory is outside store root");
    }
    await handle.chmod(mode).catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function createMaxBytesTransform(maxBytes: number | undefined): Transform | undefined {
  if (maxBytes === undefined) {
    return undefined;
  }
  let total = 0;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        callback(new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`));
        return;
      }
      callback(null, buffer);
    },
  });
}

export async function writeStreamToTempSource(params: {
  stream: Readable;
  maxBytes?: number;
  mode: number;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tempRoot = resolveSecureTempRoot({
    fallbackPrefix: "fs-safe-file-store",
    unsafeFallbackLabel: "file store temp dir",
    warn: () => undefined,
  });
  const dir = await fs.mkdtemp(path.join(tempRoot, "fs-safe-file-store-"));
  const filePath = path.join(dir, "payload");
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let handleClosedByStream = false;
  try {
    handle = await fs.open(filePath, "wx", params.mode);
    const writable = handle.createWriteStream();
    writable.once("close", () => {
      handleClosedByStream = true;
    });
    const limiter = createMaxBytesTransform(params.maxBytes);
    if (limiter) {
      await pipeline(params.stream, limiter, writable);
    } else {
      await pipeline(params.stream, writable);
    }
    if (!handleClosedByStream) {
      await handle.close().catch(() => undefined);
    }
    await fs.chmod(filePath, params.mode).catch(() => undefined);
    return {
      path: filePath,
      cleanup: async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    if (handle && !handleClosedByStream) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export function assertSyncDirectoryGuard(guard: SyncParentGuard): void {
  try {
    assertDirectoryGuardSync(guard);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch") {
      throw new FsSafeError("path-mismatch", "store directory changed during write", {
        cause: error,
      });
    }
    throw error;
  }
}

function chmodDirectorySyncBestEffort(dir: string, mode: number): void {
  try {
    syncFs.chmodSync(dir, mode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
}

export function ensureParentSync(params: {
  rootDir: string;
  filePath: string;
  mode: number;
}): SyncParentGuard {
  return ensureStoreDirectorySync({
    rootDir: params.rootDir,
    targetDir: path.dirname(path.resolve(params.filePath)),
    mode: params.mode,
    messagePrefix: "store",
  });
}

export function ensureStoreDirectorySync(params: {
  rootDir: string;
  targetDir: string;
  mode: number;
  messagePrefix: "private store" | "store";
}): SyncParentGuard {
  const rootDir = path.resolve(params.rootDir);
  const dir = path.resolve(params.targetDir);
  const relative = path.relative(rootDir, dir);
  if (isPathRelativeEscape(relative)) {
    throw new FsSafeError("outside-workspace", "file path escapes store root");
  }

  syncFs.mkdirSync(rootDir, { recursive: true, mode: params.mode });
  const rootStat = syncFs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FsSafeError(
      "not-file",
      `${params.messagePrefix} root must be a directory: ${rootDir}`,
    );
  }
  const rootReal = syncFs.realpathSync(rootDir);
  chmodDirectorySyncBestEffort(rootDir, params.mode);

  let current = rootDir;
  for (const segment of path.relative(rootDir, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = syncFs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError(
          "not-file",
          `${params.messagePrefix} directory component must be a directory: ${current}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      syncFs.mkdirSync(current, { mode: params.mode });
    }
    const currentRootStat = syncFs.lstatSync(rootDir);
    const currentRootReal = syncFs.realpathSync(rootDir);
    const currentReal = syncFs.realpathSync(current);
    if (
      currentRootStat.isSymbolicLink() ||
      !currentRootStat.isDirectory() ||
      !sameFileIdentity(rootStat, currentRootStat) ||
      currentRootReal !== rootReal ||
      !isPathInside(rootReal, currentReal)
    ) {
      throw new FsSafeError(
        "outside-workspace",
        `${params.messagePrefix} directory escapes root`,
      );
    }
    chmodDirectorySyncBestEffort(current, params.mode);
  }

  const guard = createSyncDirectoryGuard(dir);
  assertSyncDirectoryGuard(guard);
  return guard;
}
