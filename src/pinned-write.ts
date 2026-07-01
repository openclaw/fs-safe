import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { createAsyncDirectoryGuard, createNearestExistingDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./fsync.js";
import type { FileIdentityStat } from "./file-identity.js";
import { sameFileIdentity, sha256Hex } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { canFallbackFromPythonError, getFsSafePythonConfig } from "./pinned-python-config.js";
import {
  assertPinnedPythonOperationAvailable,
  runPinnedPythonOperation,
  validatePinnedOperationPayload,
} from "./pinned-python.js";
import { withSidecarLock } from "./sidecar-lock.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

type PinnedWriteInput =
  | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding }
  | { kind: "stream"; stream: Readable };

function byteLength(input: string | Buffer, encoding: BufferEncoding | undefined): number {
  return typeof input === "string"
    ? Buffer.byteLength(input, encoding ?? "utf8")
    : input.byteLength;
}

function assertSafeBasename(basename: string): void {
  if (
    !basename ||
    basename === "." ||
    basename === ".." ||
    basename.includes("/") ||
    basename.includes("\0")
  ) {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
}

function assertWithinMaxBytes(bytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
    );
  }
}

async function writeStreamToHandle(
  stream: Readable,
  handle: FileHandle,
  maxBytes: number | undefined,
): Promise<void> {
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    assertWithinMaxBytes(bytes, maxBytes);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.byteLength - offset,
      );
      if (bytesWritten <= 0) {
        throw new FsSafeError("helper-failed", "fallback stream write made no progress");
      }
      offset += bytesWritten;
    }
  }
}

async function inputToBase64(
  input: PinnedWriteInput,
  maxBytes: number | undefined,
): Promise<string> {
  if (input.kind === "buffer") {
    assertWithinMaxBytes(byteLength(input.data, input.encoding), maxBytes);
    return (
      typeof input.data === "string"
        ? Buffer.from(input.data, input.encoding ?? "utf8")
        : input.data
    ).toString("base64");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input.stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    assertWithinMaxBytes(bytes, maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("base64");
}

type RenameIdentityMismatchPolicy = "throw" | "verify-content";

export type RenameIdentityPolicy = "strict" | "verify-content-with-lock";

type PinnedWriteParams = {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  overwrite?: boolean;
  maxBytes?: number;
  input: PinnedWriteInput;
  rootIdentity?: FileIdentityStat;
  onRenameIdentityMismatch?: RenameIdentityMismatchPolicy;
};

export async function runPinnedWriteHelper(params: PinnedWriteParams): Promise<FileIdentityStat> {
  assertSafeBasename(params.basename);
  validatePinnedOperationPayload({
    relativeParentPath: params.relativeParentPath,
  });
  // The Python helper deliberately enforces the strict post-rename inode
  // contract. The explicit compatibility policy therefore uses the guarded
  // Node fallback, where content verification can replace that one check.
  if (params.onRenameIdentityMismatch === "verify-content") {
    return await runPinnedWriteFallback(params);
  }
  if (getFsSafePythonConfig().mode === "off") {
    return await runPinnedWriteFallback(params);
  }
  if (params.input.kind === "stream") {
    try {
      assertPinnedPythonOperationAvailable();
    } catch (error) {
      if (canFallbackFromPythonError(error)) {
        return await runPinnedWriteFallback(params);
      }
      throw error;
    }
  }
  const input =
    params.input.kind === "stream"
      ? { kind: "buffer" as const, data: Buffer.from(await inputToBase64(params.input, params.maxBytes), "base64") }
      : params.input;
  const payload = {
    base64: await inputToBase64(input, params.maxBytes),
    basename: params.basename,
    maxBytes: params.maxBytes ?? -1,
    mkdir: params.mkdir,
    mode: params.mode || 0o600,
    overwrite: params.overwrite !== false,
    relativeParentPath: params.relativeParentPath,
    ...(params.rootIdentity ? { rootDev: params.rootIdentity.dev, rootIno: params.rootIdentity.ino } : {}),
  };
  try {
    return await runPinnedPythonOperation<FileIdentityStat>({
      operation: "write",
      rootPath: params.rootPath,
      payload,
    });
  } catch (error) {
    if (canFallbackFromPythonError(error)) {
      return await runPinnedWriteFallback({ ...params, input });
    }
    throw error;
  }
}

export async function runPinnedWriteWithRenamePolicy(
  params: PinnedWriteParams & {
    targetPath: string;
    renameIdentity?: RenameIdentityPolicy;
  },
): Promise<FileIdentityStat> {
  const { targetPath, renameIdentity, ...writeParams } = params;
  if (renameIdentity !== "verify-content-with-lock") {
    return await runPinnedWriteHelper(writeParams);
  }
  return await withSidecarLock(
    targetPath,
    {
      managerKey: `fs-safe.write:${targetPath}`,
      createParent: writeParams.mkdir,
      staleMs: 30_000,
      timeoutMs: 5_000,
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      retry: { retries: 5, minTimeout: 100, maxTimeout: 2_000, factor: 2 },
    },
    async () => await runPinnedWriteHelper({
      ...writeParams,
      onRenameIdentityMismatch: "verify-content",
    }),
  );
}

export async function runPinnedCopyHelper(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  overwrite?: boolean;
  maxBytes?: number;
  sourcePath: string;
  sourceIdentity: FileIdentityStat;
  rootIdentity?: FileIdentityStat;
}): Promise<FileIdentityStat> {
  assertSafeBasename(params.basename);
  validatePinnedOperationPayload({
    relativeParentPath: params.relativeParentPath,
  });
  return await runPinnedPythonOperation<FileIdentityStat>({
    operation: "copy",
    rootPath: params.rootPath,
    payload: {
      basename: params.basename,
      maxBytes: params.maxBytes ?? -1,
      mkdir: params.mkdir,
      mode: params.mode || 0o600,
      overwrite: params.overwrite !== false,
      relativeParentPath: params.relativeParentPath,
      ...(params.rootIdentity ? { rootDev: params.rootIdentity.dev, rootIno: params.rootIdentity.ino } : {}),
      sourceDev: params.sourceIdentity.dev,
      sourceIno: params.sourceIdentity.ino,
      sourcePath: params.sourcePath,
    },
  });
}

async function runPinnedWriteFallback(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  overwrite?: boolean;
  maxBytes?: number;
  input: PinnedWriteInput;
  onRenameIdentityMismatch?: RenameIdentityMismatchPolicy;
}): Promise<FileIdentityStat> {
  const parentPath = params.relativeParentPath
    ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
    : params.rootPath;
  if (params.mkdir) {
    await mkdirPathComponentsWithGuards({ rootReal: params.rootPath, targetPath: parentPath });
  }
  const parentGuard = params.mkdir
    ? await createAsyncDirectoryGuard(parentPath)
    : await createNearestExistingDirectoryGuard(params.rootPath, parentPath);
  const targetPath = path.join(parentPath, params.basename);
  if (params.overwrite === false) {
    let handle = await withAsyncDirectoryGuards(
      [parentGuard],
      async () =>
        await fs.open(
          targetPath,
          fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
          params.mode,
        ),
      {
        onPostGuardFailure: async (openedHandle) => {
          // The parent failed verification, so targetPath may now resolve
          // somewhere else. Close the fd, but do not clean up by path.
          await openedHandle.close().catch(() => undefined);
        },
      },
    );
    let created = true;
    try {
      if (params.input.kind === "buffer") {
        assertWithinMaxBytes(
          byteLength(params.input.data, params.input.encoding),
          params.maxBytes,
        );
        if (typeof params.input.data === "string") {
          await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
        } else {
          await handle.writeFile(params.input.data);
        }
      } else {
        await writeStreamToHandle(params.input.stream, handle, params.maxBytes);
      }
      await handle.sync();
      const stat = await handle.stat();
      await handle.close().catch(() => undefined);
      await syncDirectoryBestEffort(parentPath);
      created = false;
      return { dev: stat.dev, ino: stat.ino };
    } finally {
      await handle.close().catch(() => undefined);
      if (created) {
        await fs.rm(targetPath, { force: true }).catch(() => undefined);
      }
    }
  }

  const tempPath = path.join(parentPath, `.${params.basename}.${randomUUID()}.fallback.tmp`);
  const tempFlags =
    fsSync.constants.O_WRONLY |
    fsSync.constants.O_CREAT |
    fsSync.constants.O_EXCL |
    (process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants
      ? fsSync.constants.O_NOFOLLOW
      : 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempStat: Awaited<ReturnType<NonNullable<typeof handle>["stat"]>> | undefined;
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  let renamed = false;
  try {
    handle = await fs.open(tempPath, tempFlags, params.mode);
    if (params.input.kind === "buffer") {
      assertWithinMaxBytes(
        byteLength(params.input.data, params.input.encoding),
        params.maxBytes,
      );
      if (typeof params.input.data === "string") {
        await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
      } else {
        await handle.writeFile(params.input.data);
      }
    } else {
      await writeStreamToHandle(params.input.stream, handle, params.maxBytes);
    }
    tempStat = await handle.stat();
    const tempPathStat = await fs.lstat(tempPath);
    if (tempPathStat.isSymbolicLink() || !sameFileIdentity(tempPathStat, tempStat)) {
      throw new FsSafeError("path-mismatch", "fallback temp path changed during write");
    }
    const expectedTempStat = tempStat;
    await handle.sync();
    await handle.close().catch(() => undefined);
    handle = undefined;
    await withAsyncDirectoryGuards([parentGuard], async () => {
      await fs.rename(tempPath, targetPath);
      renamed = true;
      await getFsSafeTestHooks()?.afterPinnedWriteFallbackRename?.(targetPath);
      await syncDirectoryBestEffort(parentPath);
      targetStat = await fs.lstat(targetPath);
      if (targetStat.isSymbolicLink()) {
        throw new FsSafeError("path-mismatch", "fallback target changed during write");
      }
      if (!sameFileIdentity(targetStat, expectedTempStat)) {
        // On filesystems like rclone FUSE where rename(2) causes every subsequent
        // path-based lookup to mint a fresh inode, the (dev,ino) check always fails
        // even with zero concurrency. The caller is responsible for ensuring mutual
        // exclusion before passing "verify-content"; fall back to a content-hash
        // comparison. A hash mismatch still throws.
        if (params.onRenameIdentityMismatch !== "verify-content") {
          throw new FsSafeError("path-mismatch", "fallback target changed during write");
        }
        if (params.input.kind !== "buffer") {
          throw new FsSafeError("path-mismatch", "fallback target changed during write");
        }
        const expectedHash = sha256Hex(params.input.data, params.input.encoding);
        const readFlags =
          fsSync.constants.O_RDONLY |
          (process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants
            ? fsSync.constants.O_NOFOLLOW
            : 0);
        const readHandle = await fs.open(targetPath, readFlags);
        let actualHash: string;
        let readHandleStat: Awaited<ReturnType<typeof readHandle.stat>>;
        try {
          // Capture fd-based identity before reading — this is stable across all
          // subsequent lookups (on FUSE and locally), unlike the lstat-based
          // targetStat that triggered this fallback.
          readHandleStat = await readHandle.stat();
          actualHash = sha256Hex(await readHandle.readFile());
        } finally {
          await readHandle.close().catch(() => undefined);
        }
        if (actualHash !== expectedHash) {
          throw new FsSafeError("path-mismatch", "fallback target changed during write");
        }
        // Replace the unreliable lstat-based targetStat with the fd-based stat so
        // the returned identity is consistent with what subsequent verifications
        // (e.g. verifyAtomicWriteResult) will obtain by opening the same file.
        targetStat = readHandleStat;
      }
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  if (!targetStat) {
    throw new FsSafeError("path-mismatch", "fallback target was not verified");
  }
  return { dev: targetStat.dev, ino: targetStat.ino };
}
