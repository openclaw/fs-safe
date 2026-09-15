import { syncFileBestEffort } from "./file-sync.js";
import { randomUUID } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, createNearestExistingDirectoryGuard, inspectDirectoryIdentity, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import type { FileIdentityStat } from "./file-identity.js";
import { sameFileIdentity, sha256Hex } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { runPinnedWriteNative } from "./native-pinned-write.js";
import { getNativeBinding } from "./native.js";
import { validatePinnedOperationPayload } from "./pinned-operation.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { cleanupPinnedFilePath } from "./replace-file-temp-owner.js";
import { withSidecarLock } from "./sidecar-lock.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { writeAllToFile } from "./write-file-handle.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { type CopyFileInput, writeCopyFileToFd } from "./copy-file-input.js";
import { publishCopyStage } from "./publish-copy-stage.js";
import type { MutationDirectoryObservation } from "./pinned-mutation-observation.js";

export type PinnedWriteInput =
  | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding }
  | { kind: "stream"; stream: AsyncIterable<Uint8Array | string>; stageBeforePublish?: boolean }
  | CopyFileInput;

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

function fastParentGuardDeopt(error: unknown): error is FsSafeError {
  return error instanceof FsSafeError &&
    (error.code === "path-mismatch" || error.code === "not-file");
}

async function writeStreamToHandle(
  stream: AsyncIterable<Uint8Array | string>,
  handle: FileHandle,
  maxBytes: number | undefined,
  assertBeforeMutation?: () => void,
): Promise<void> {
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    assertWithinMaxBytes(bytes, maxBytes);
    await writeAllToFile(handle, buffer, { assertBeforeMutation });
  }
}

export type RenameIdentityPolicy = "strict" | "verify-content-with-lock";

export type PublishedWriteIdentity = Readonly<{ dev: bigint; ino: bigint }>;

// Opaque operation-local proof that the immediately preceding parent-create
// admission belongs to the epoch a directory walk is advancing.
export type PinnedMutationAdmissionReceipt = Readonly<object>;

// Opaque operation-local proof that a synchronous, guard-bound authorization
// completed without crossing an await boundary.
export type PinnedMutationAuthorizationToken = Readonly<object>;

// Full post-create facts paired with the exact admission that authorized the
// mkdir. Every nested object is frozen before it reaches the epoch updater.
export type PinnedCreatedDirectoryReceipt = Readonly<{
  admission: PinnedMutationAdmissionReceipt;
  parent: MutationDirectoryObservation;
  child: MutationDirectoryObservation;
}>;

export type PinnedMutationParentWalkSession = Readonly<{
  retainedTargetPath: string;
  tryAuthorizeAtParent(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>, parent: MutationDirectoryObservation): PinnedMutationAuthorizationToken | undefined;
  authorize(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>): Promise<PinnedMutationAdmissionReceipt | undefined>;
  advanceCreatedDirectory(
    receipt: PinnedCreatedDirectoryReceipt,
  ): PinnedMutationAuthorizationToken | undefined;
  dispose(): void;
}>;

export type PinnedWriteMutationAdmission = Readonly<{
  rejectParentSymlinks: boolean;
  beginParentWalk?(): string | undefined;
  beginSharedParentWalk?(): PinnedMutationParentWalkSession | undefined;
  tryAuthorizeAtParent?(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>, parent: MutationDirectoryObservation): PinnedMutationAuthorizationToken | undefined;
  authorize(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>): Promise<PinnedMutationAdmissionReceipt | undefined>;
  advanceCreatedDirectory?(
    receipt: PinnedCreatedDirectoryReceipt,
  ): PinnedMutationAuthorizationToken | undefined;
}>;

export type PinnedWriteParams = {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  sync?: boolean;
  overwrite?: boolean;
  assertBeforeMutation?: () => void;
  rejectFinalSymlink?: boolean;
  maxBytes?: number;
  input: PinnedWriteInput;
  rootIdentity?: FileIdentityStat;
  mutationAdmission?: PinnedWriteMutationAdmission;
  onRenameIdentityMismatch?: "verify-content";
  onPublished?: (identity: PublishedWriteIdentity) => void;
  // Borrowed only for this callback; the writer closes every descriptor in finally.
  verifyPublished?: (
    fd: number,
    identity: PublishedWriteIdentity,
    parentGuard: AnyAsyncDirectoryGuard,
  ) => Promise<void>;
};

export async function runPinnedWriteHelper(params: PinnedWriteParams): Promise<FileIdentityStat> {
  const normalizedParams = { ...params, maxBytes: normalizeMaxBytes(params.maxBytes) };
  assertSafeBasename(params.basename);
  validatePinnedOperationPayload({
    relativeParentPath: params.relativeParentPath,
  });
  if (normalizedParams.mutationAdmission) {
    const targetPath = path.join(
      normalizedParams.rootPath,
      ...normalizedParams.relativeParentPath.split("/").filter(Boolean),
      normalizedParams.basename,
    );
    await getFsSafeTestHooks()?.beforePinnedWriteParentAdmission?.(targetPath);
  }
  // The explicit compatibility policy uses the guarded Node fallback, where
  // content verification can replace the strict post-rename inode check.
  if (normalizedParams.onRenameIdentityMismatch === "verify-content") {
    return await runPinnedWriteFallback(normalizedParams);
  }
  const native = getNativeBinding();
  if (native) {
    return await runPinnedWriteNative(native, normalizedParams);
  }
  return await runPinnedWriteFallback(normalizedParams);
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
  const exactRoot = typeof params.rootIdentity?.dev === "bigint" && typeof params.rootIdentity.ino === "bigint"
    ? { dev: params.rootIdentity.dev, ino: params.rootIdentity.ino } : undefined;
  const mutationAdmission = params.mutationAdmission;
  if (exactRoot) await inspectDirectoryIdentity(params.rootPath, exactRoot);
  let parentPath = params.relativeParentPath
    ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
    : params.rootPath;
  let parentGuard: AnyAsyncDirectoryGuard | undefined;
  let parentAdmitted = false;
  const initialTargetPath = path.join(parentPath, params.basename);
  const retainedTargetPath = mutationAdmission?.beginParentWalk?.();
  const ordinaryRetainedTarget = retainedTargetPath !== undefined &&
    path.relative(path.resolve(retainedTargetPath), path.resolve(initialTargetPath)) === "";
  let fastGuardClassifierFailure: FsSafeError | undefined;
  if (ordinaryRetainedTarget) {
    try {
      parentGuard = await createAsyncDirectoryGuard(parentPath, { bigint: true });
    } catch (error) {
      // Only a genuinely missing complete parent may enter the component
      // creator. ENOTDIR, permission, identity, and canonicalization failures
      // retain their original fail-closed result.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        if (!fastParentGuardDeopt(error)) throw error;
        fastGuardClassifierFailure = error;
      }
    }
    if (parentGuard) {
      await mutationAdmission!.authorize(Object.freeze({
        targetPath: initialTargetPath,
        mutationPath: initialTargetPath,
        phase: "parent" as const,
      }));
      await assertAsyncDirectoryGuard(parentGuard);
      parentAdmitted = true;
    }
  }
  if (fastGuardClassifierFailure) {
    // The optimized exact-guard classifier runs before policy admission. Let
    // the established resolver restore deny/symlink precedence before using
    // the guarded walker or reporting the classifier failure. Because this
    // was not an ENOENT probe, it may never authorize a newly missing parent.
    await mutationAdmission!.authorize(Object.freeze({
      targetPath: initialTargetPath,
      mutationPath: initialTargetPath,
      phase: "parent" as const,
    }));
  }
  if (params.mkdir && !parentGuard) {
    // mkdirPathComponentsWithGuards may resolve the final component through
    // an in-root symlink (e.g. a skill-bank layout). Use its returned real
    // path for the subsequent guard and target path so we don't re-check the
    // original, possibly-symlinked, lexical path and reject it outright.
    const mkdirParams = {
      rootReal: params.rootPath,
      targetPath: parentPath,
      rootIdentity: params.rootIdentity,
      assertBeforeMutation: params.assertBeforeMutation,
      beforeComponent: async (componentPath: string) => {
        await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath);
      },
    };
    parentPath = await mkdirPathComponentsWithGuards(mutationAdmission ? {
      ...mkdirParams,
      rejectSymlinks: mutationAdmission.rejectParentSymlinks,
      revalidateParentAfterBeforeComponent: true,
      synchronousAuthorizationIncludesFence: true,
      retainedTargetPath,
      afterCreateComponent: mutationAdmission.advanceCreatedDirectory,
      beforeCreateComponent: (
        componentPath: string,
        prospectiveParentPath: string,
        retainedTarget: string | undefined,
        parent: MutationDirectoryObservation,
      ) => {
        if (fastGuardClassifierFailure) throw fastGuardClassifierFailure;
        const request = Object.freeze({
          targetPath: retainedTarget ?? path.join(prospectiveParentPath, params.basename),
          mutationPath: componentPath,
          phase: "parent-create" as const,
        });
        return mutationAdmission.tryAuthorizeAtParent?.(request, parent) ??
          mutationAdmission.authorize(request);
      },
      beforeUseComponent: async (
        _componentPath: string,
        prospectiveParentPath: string,
        retainedTarget: string | undefined,
      ) => {
        const targetPath = retainedTarget ?? path.join(prospectiveParentPath, params.basename);
        await mutationAdmission.authorize(Object.freeze({
          targetPath,
          mutationPath: targetPath,
          phase: "parent" as const,
        }));
      },
    } : mkdirParams);
  }
  parentGuard ??= params.mkdir
    ? await createAsyncDirectoryGuard(parentPath, { bigint: true })
    : await createNearestExistingDirectoryGuard(params.rootPath, parentPath, { bigint: true });
  const targetPath = path.join(parentPath, params.basename);
  if (mutationAdmission && !parentAdmitted) {
    await mutationAdmission.authorize(Object.freeze({
      targetPath,
      mutationPath: targetPath,
      phase: "parent" as const,
    }));
    await assertAsyncDirectoryGuard(parentGuard);
  }
  if (params.overwrite === false && (params.input.kind === "buffer" ||
    (params.input.kind === "stream" && !params.input.stageBeforePublish))) {
    const assertBeforeMutation = () => {
      assertFinalSymlinkRejected(targetPath, params.rejectFinalSymlink);
      params.assertBeforeMutation?.();
    };
    const handle = await withAsyncDirectoryGuards(
      [parentGuard],
      async () => {
        assertBeforeMutation();
        return await fs.open(
          targetPath,
          fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
          params.mode,
        );
      },
      {
        onPostGuardFailure: async (openedHandle) => {
          // The parent failed verification, so targetPath may now resolve
          // somewhere else. Close the fd, but do not clean up by path.
          await openedHandle.close().catch(() => undefined);
        },
      },
    );
    let created = true;
    let createdIdentity: BigIntStats | undefined;
    try {
      const verificationIdentity = fsSync.fstatSync(handle.fd, { bigint: true });
      createdIdentity = verificationIdentity;
      if (params.input.kind === "buffer") {
        assertWithinMaxBytes(
          byteLength(params.input.data, params.input.encoding),
          params.maxBytes,
        );
        await writeAllToFile(handle, params.input.data, {
          encoding: params.input.encoding, assertBeforeMutation,
        });
      } else {
        await writeStreamToHandle(params.input.stream, handle, params.maxBytes, assertBeforeMutation);
      }
      // Content writes may clear set-ID bits; finalize them through the owned fd.
      await handle.chmod(params.mode);
      if (params.sync !== false) await syncFileBestEffort(handle);
      const stat = fsSync.fstatSync(handle.fd);
      if (params.sync !== false) await syncDirectoryBestEffort(parentPath);
      // Publication is complete. A failed outer check must not remove its target.
      created = false;
      await params.verifyPublished?.(handle.fd, verificationIdentity, parentGuard);
      return { dev: stat.dev, ino: stat.ino };
    } finally {
      try {
        if (created) {
          await cleanupPinnedFilePath({ pathname: targetPath, handle, identity: createdIdentity, parentGuard });
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }

  // Private staging must not consume the destination basename's filename budget.
  const tempPath = path.join(parentPath, `.fs-safe-${randomUUID()}.tmp`);
  const tempFlags =
    fsSync.constants.O_WRONLY |
    fsSync.constants.O_CREAT |
    fsSync.constants.O_EXCL |
    (process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants
      ? fsSync.constants.O_NOFOLLOW
      : 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempStat: Awaited<ReturnType<NonNullable<typeof handle>["stat"]>> | undefined;
  let tempIdentity: BigIntStats | undefined;
  let readHandle: FileHandle | undefined;
  let renamed = false;
  try {
    params.assertBeforeMutation?.();
    handle = await fs.open(tempPath, tempFlags, params.mode);
    let verificationIdentity = fsSync.fstatSync(handle.fd, { bigint: true });
    tempIdentity = verificationIdentity;
    if (params.input.kind === "buffer") {
      assertWithinMaxBytes(
        byteLength(params.input.data, params.input.encoding),
        params.maxBytes,
      );
      await writeAllToFile(handle, params.input.data, {
        encoding: params.input.encoding, assertBeforeMutation: params.assertBeforeMutation,
      });
    } else if (params.input.kind === "file") {
      await writeCopyFileToFd(handle.fd, params.input, params.maxBytes, params.assertBeforeMutation);
    } else {
      await writeStreamToHandle(params.input.stream, handle, params.maxBytes, params.assertBeforeMutation);
    }
    tempStat = fsSync.fstatSync(handle.fd);
    const tempPathStat = fsSync.lstatSync(tempPath);
    if (tempPathStat.isSymbolicLink() || !sameFileIdentity(tempPathStat, tempStat)) {
      throw new FsSafeError("path-mismatch", "fallback temp path changed during write");
    }
    const expectedTempStat = tempStat;
    await handle.chmod(params.mode);
    if (params.sync !== false) await syncFileBestEffort(handle);
    if (params.input.kind === "file") await params.input.verifySource();
    let verifiedIdentity: FileIdentityStat = expectedTempStat;
    await withAsyncDirectoryGuards([parentGuard], async () => {
      assertFinalSymlinkRejected(targetPath, params.rejectFinalSymlink);
      if (params.overwrite === false) {
        publishCopyStage({
          temporaryPath: tempPath, targetPath, fd: handle!.fd,
          identity: tempIdentity!, parentGuard,
          assertBeforeMutation: params.assertBeforeMutation,
          onPublished: (identity) => {
            renamed = true;
            params.onPublished?.(identity);
          },
        });
      } else {
        params.assertBeforeMutation?.();
        await fs.rename(tempPath, targetPath);
        renamed = true;
        params.onPublished?.(verificationIdentity);
      }
      await getFsSafeTestHooks()?.afterPinnedWriteFallbackRename?.(targetPath);
      if (params.sync !== false) await syncDirectoryBestEffort(parentPath);
      const targetStat = fsSync.lstatSync(targetPath);
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
        readHandle = await fs.open(targetPath, resolveReadOpenFlags());
        const readHandleStat = fsSync.fstatSync(readHandle.fd, { bigint: true });
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
    try {
      if (!renamed && handle) {
        await cleanupPinnedFilePath({ pathname: tempPath, handle, identity: tempIdentity, parentGuard });
      }
    } finally {
      await readHandle?.close().catch(() => undefined);
      await handle?.close().catch(() => undefined);
    }
  }
}
