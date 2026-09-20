import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Transform, Readable } from "node:stream";
import { createByteLimitTransform } from "./bounded-read-stream.js";
import { normalizeMaxBytes } from "./byte-budget.js";
import { pipeline } from "node:stream/promises";
import { FsSafeError } from "./errors.js";
import {
  assertSyncStoreDirectoryReceipt,
  ensureSyncStoreDirectory,
  type SyncStoreDirectoryReceipt,
} from "./file-store-sync-directory.js";
import { isPathInside } from "./path.js";
import { resolveOpenedFileRealPathForHandle, root, type Root } from "./root.js";
import { ensureTrailingSep } from "./root-context.js";
import { RootHandle } from "./root-impl.js";
import { prepareSecretFileWrite } from "./secret-file.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type SyncParentGuard = SyncStoreDirectoryReceipt;

export async function ensureParentInRoot(
  scopedRoot: Root,
  relativePath: string,
  mode: number,
): Promise<void> {
  const parent = path.posix.dirname(relativePath);
  if (parent === ".") {
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
  assertNoWindowsPathAlias(params.rootDir, "filesystem", "store root uses a Windows filesystem namespace alias");
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  await fs.mkdir(recursiveMkdirPath(params.rootDir), { recursive: true, mode: params.dirMode });
  await fs.chmod(params.rootDir, params.dirMode).catch(() => undefined);
  return await root(params.rootDir, { hardlinks: "reject", maxBytes });
}

export async function openPrivateStoreLockRoot(
  params: Parameters<typeof prepareSecretFileWrite>[0],
): Promise<Root> {
  const { parentGuard } = await prepareSecretFileWrite(params);
  // Bind to the admitted parent, never resolve a replacement into a fresh capability.
  return new RootHandle({
    rootDir: parentGuard.dir,
    rootGuard: { dir: parentGuard.realPath, realPath: parentGuard.realPath, stat: parentGuard.stat },
    rootReal: parentGuard.realPath,
    rootWithSep: ensureTrailingSep(parentGuard.realPath),
    rootIdentity: { dev: parentGuard.stat.dev, ino: parentGuard.stat.ino },
  }, { hardlinks: "reject" });
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
    const stat = syncFs.fstatSync(handle.fd);
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
  const limit = normalizeMaxBytes(maxBytes);
  if (limit === undefined) {
    return undefined;
  }
  return createByteLimitTransform(limit, () =>
    new FsSafeError("too-large", `file exceeds maximum size of ${limit} bytes`));
}

export async function writeStreamToTempSource(params: {
  stream: Readable;
  maxBytes?: number;
  mode: number;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const maxBytes = normalizeMaxBytes(params.maxBytes);
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
    const limiter = createMaxBytesTransform(maxBytes);
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

export function ensureParentSync(params: {
  rootDir: string;
  filePath: string;
  mode: number;
}): SyncParentGuard {
  assertNoWindowsPathAlias(params.rootDir, "filesystem", "store root uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(params.filePath, "filesystem", "store path uses a Windows filesystem namespace alias");
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
  const guard = ensureSyncStoreDirectory(params);
  assertSyncStoreDirectoryReceipt(guard);
  return guard;
}
