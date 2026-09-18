import { randomUUID } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AsyncDirectoryGuard } from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity, sha256Hex, type FileIdentityStat } from "./file-identity.js";
import { syncFileBestEffort } from "./file-sync.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { writePinnedInput } from "./pinned-write-input.js";
import type { PinnedWriteParams } from "./pinned-write-types.js";
import { publishCopyStage } from "./publish-copy-stage.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { createStagedFileReceipt, settleStagedFile } from "./staged-file-settlement.js";
import type { StagedFileFailureDetails, StagedFilePublication, StagedFileReceipt } from "./staged-file-types.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export async function runPinnedStagedWrite(
  params: PinnedWriteParams,
  parentPath: string,
  parentGuard: AsyncDirectoryGuard<BigIntStats>,
): Promise<FileIdentityStat> {
  const targetPath = path.join(parentPath, params.basename);
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
  const completeCreate = params.overwrite === false && params.input.kind !== "file" && params.input.stageBeforePublish === true;
  let receipt: StagedFileReceipt | undefined;
  let publication: StagedFilePublication = Object.freeze({ status: "not-published" });
  let phase: StagedFileFailureDetails["phase"] = "prepare";
  let failure: { error: unknown } | undefined;
  try {
    params.assertBeforeMutation?.();
    handle = await fs.open(tempPath, tempFlags, params.mode);
    let verificationIdentity = fsSync.fstatSync(handle.fd, { bigint: true });
    tempIdentity = verificationIdentity;
    await writePinnedInput(handle, params.input, params.maxBytes, params.assertBeforeMutation);
    tempStat = fsSync.fstatSync(handle.fd);
    const tempPathStat = fsSync.lstatSync(tempPath);
    if (tempPathStat.isSymbolicLink() || !sameFileIdentity(tempPathStat, tempStat)) {
      throw new FsSafeError("path-mismatch", "fallback temp path changed during write");
    }
    const expectedTempStat = tempStat;
    await handle.chmod(params.mode);
    if (params.sync !== false) {
      if (params.strictFileSync) await handle.sync();
      else await syncFileBestEffort(handle);
    }
    if (params.input.kind === "file") await params.input.verifySource();
    if (completeCreate) {
      receipt = createStagedFileReceipt(Object.freeze({
        path: parentGuard.dir,
        realPath: parentGuard.realPath,
        identity: Object.freeze({ dev: parentGuard.stat.dev, ino: parentGuard.stat.ino }),
      }), path.basename(tempPath), fsSync.fstatSync(handle.fd, { bigint: true }));
    }
    let verifiedIdentity: FileIdentityStat = expectedTempStat;
    phase = "publish";
    await withAsyncDirectoryGuards([parentGuard], async () => {
      assertFinalSymlinkRejected(targetPath, params.rejectFinalSymlink);
      if (params.overwrite === false) {
        publishCopyStage({
          temporaryPath: tempPath, targetPath, fd: handle!.fd,
          identity: tempIdentity!, parentGuard,
          assertBeforeMutation: params.assertBeforeMutation,
          onPublicationAttempt: () => {
            if (receipt) publication = Object.freeze({ status: "indeterminate", basename: params.basename, overwrite: false });
          },
          onPublished: (identity) => {
            renamed = true;
            if (receipt) publication = Object.freeze({ status: "published", staged: receipt, basename: params.basename, overwrite: false });
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
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    if (completeCreate) {
      await settleStagedFile({
        temporaryBasename: path.basename(tempPath), publication, phase, failure,
        cleanup: async () => {
          if (publication.status === "indeterminate") return "preserved";
          if (renamed) {
            return failure?.error instanceof FsSafeError && failure.error.details?.cleanup === "failed"
              ? "failed" : "not-needed";
          }
          return handle ? await cleanupPinnedFilePath({
            pathname: tempPath, handle, identity: tempIdentity, parentGuard, throwOnCleanupError: true,
          }) : "not-needed";
        },
        close: [async () => { await readHandle?.close(); }, async () => { await handle?.close(); }],
      });
    } else try {
      if (!renamed && handle) {
        await cleanupPinnedFilePath({ pathname: tempPath, handle, identity: tempIdentity, parentGuard });
      }
    } finally {
      await readHandle?.close().catch(() => undefined);
      await handle?.close().catch(() => undefined);
    }
  }
}
