import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { createAsyncDirectoryGuard, createNearestExistingDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./fsync.js";
import type { FileIdentityStat } from "./file-identity.js";
import { sameFileIdentity, sha256Hex } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { runPinnedWriteNative } from "./native-pinned-write.js";
import { getNativeBinding } from "./native.js";
import { validatePinnedOperationPayload } from "./pinned-operation.js";
import { withSidecarLock } from "./sidecar-lock.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export type PinnedWriteInput =
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

async function syncFileBestEffort(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EPERM") {
      throw error;
    }
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

export type RenameIdentityMismatchPolicy = "throw" | "verify-content";

export type RenameIdentityPolicy = "strict" | "verify-content-with-lock";

export type PublishedWriteIdentity = Readonly<{ dev: bigint; ino: bigint }>;

export type PinnedWriteParams = {
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
  // Borrowed only for this callback; the writer closes every descriptor in finally.
  verifyPublished?: (
    fd: number,
    identity: PublishedWriteIdentity,
    parentGuard: AsyncDirectoryGuard,
  ) => Promise<void>;
};

export async function runPinnedWriteHelper(params: PinnedWriteParams): Promise<FileIdentityStat> {
  assertSafeBasename(params.basename);
  validatePinnedOperationPayload({
    relativeParentPath: params.relativeParentPath,
  });
  // The explicit compatibility policy uses the guarded Node fallback, where
  // content verification can replace the strict post-rename inode check.
  if (params.onRenameIdentityMismatch === "verify-content") {
    return await runPinnedWriteFallback(params);
  }
  const native = getNativeBinding();
  if (native) {
    return await runPinnedWriteNative(native, params);
  }
  return await runPinnedWriteFallback(params);
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
  const relativeTargetPath = writeParams.relativeParentPath
    ? `${writeParams.relativeParentPath}/${writeParams.basename}`
    : writeParams.basename;
  const lockPath = path.join(
    writeParams.rootPath,
    `.fs-safe-write-${sha256Hex(relativeTargetPath)}.lock`,
  );
  return await withSidecarLock(
    writeParams.rootPath,
    {
      managerKey: `fs-safe.write:${targetPath}`,
      lockPath,
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

async function runPinnedWriteFallback(params: PinnedWriteParams): Promise<FileIdentityStat> {
  let parentPath = params.relativeParentPath
    ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
    : params.rootPath;
  if (params.mkdir) {
    // mkdirPathComponentsWithGuards may resolve the final component through
    // an in-root symlink (e.g. a skill-bank layout). Use its returned real
    // path for the subsequent guard and target path so we don't re-check the
    // original, possibly-symlinked, lexical path and reject it outright.
    parentPath = await mkdirPathComponentsWithGuards({
      rootReal: params.rootPath,
      targetPath: parentPath,
      beforeComponent: async (componentPath) =>
        await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath),
    });
  }
  const parentGuard = params.mkdir
    ? await createAsyncDirectoryGuard(parentPath)
    : await createNearestExistingDirectoryGuard(params.rootPath, parentPath);
  const targetPath = path.join(parentPath, params.basename);
  if (params.overwrite === false) {
    const handle = await withAsyncDirectoryGuards(
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
      const verificationIdentity = await handle.stat({ bigint: true });
      await handle.chmod(params.mode);
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
      await syncFileBestEffort(handle);
      const stat = await handle.stat();
      await syncDirectoryBestEffort(parentPath);
      // Publication is complete. A failed outer check must not remove its target.
      created = false;
      await params.verifyPublished?.(handle.fd, verificationIdentity, parentGuard);
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
  let readHandle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await fs.open(tempPath, tempFlags, params.mode);
    let verificationIdentity = await handle.stat({ bigint: true });
    await handle.chmod(params.mode);
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
    await syncFileBestEffort(handle);
    let verifiedIdentity: FileIdentityStat = expectedTempStat;
    await withAsyncDirectoryGuards([parentGuard], async () => {
      await fs.rename(tempPath, targetPath);
      renamed = true;
      await getFsSafeTestHooks()?.afterPinnedWriteFallbackRename?.(targetPath);
      await syncDirectoryBestEffort(parentPath);
      const targetStat = await fs.lstat(targetPath);
      if (targetStat.isSymbolicLink()) {
        throw new FsSafeError("path-mismatch", "fallback target changed during write");
      }
      if (!sameFileIdentity(targetStat, expectedTempStat)) {
        // On filesystems like rclone FUSE, rename(2) can give the destination a
        // different inode from the source temp fd even with zero concurrency. The
        // caller must ensure mutual exclusion before passing "verify-content";
        // fall back to a content hash for this rename-boundary check only.
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
        readHandle = await fs.open(targetPath, readFlags);
        const readHandleStat = await readHandle.stat({ bigint: true });
        const actualHash = sha256Hex(await readHandle.readFile());
        if (actualHash !== expectedHash) {
          throw new FsSafeError("path-mismatch", "fallback target changed during write");
        }
        // The content-verified destination, not the old temp inode, is now pinned.
        verificationIdentity = readHandleStat;
        // Preserve the helper's legacy numeric return facts, not the private proof.
        verifiedIdentity = { dev: Number(readHandleStat.dev), ino: Number(readHandleStat.ino) };
      }
    });
    await params.verifyPublished?.((readHandle ?? handle).fd, verificationIdentity, parentGuard);
    return { dev: verifiedIdentity.dev, ino: verifiedIdentity.ino };
  } finally {
    await readHandle?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
