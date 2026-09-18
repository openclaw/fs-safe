import { syncFileBestEffortSync } from "./file-sync.js";
import { randomUUID } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import {
  nativeOpenFlags,
  removeNativeCreatedFileIfStillPinned,
  writeNativeInput,
} from "./native-operations.js";
import type { NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import type { PinnedWriteParams } from "./pinned-write.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";

interface WriteFdCloseFailure {
  error: unknown;
}

function closeWriteFd(
  closeFd: (fd: number) => void,
  fd: number | undefined,
): WriteFdCloseFailure | undefined {
  if (fd === undefined) return;
  try {
    closeFd(fd);
  } catch (error) {
    return { error };
  }
}

export async function runPinnedWriteWindows(
  binding: NativeBinding,
  params: PinnedWriteParams,
  root: FileHandle,
  parentFd: number,
  parentGuard: AnyAsyncDirectoryGuard,
): Promise<FileIdentityStat> {
  const closeFd = captureNativeFdClose(binding);
  const parentPath = parentGuard.realPath;
  let tempFd: number | undefined;
  let targetFd: number | undefined;
  let tempIdentity: BigIntStats | undefined;
  let tempName = "";
  let renamed = false;
  let completed = false;
  try {
    tempName = `.fs-safe-${randomUUID()}.tmp`;
    params.assertBeforeMutation?.();
    tempFd = binding.openBeneath(
      parentFd,
      tempName,
      nativeOpenFlags(
        fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
      ),
    ).fd;
    const verificationIdentity = inspectFileIdentitySync(() => fsSync.fstatSync(tempFd!, { bigint: true }));
    tempIdentity = verificationIdentity;
    // Creation is requested at 0600 in the binding, but a restrictive umask
    // can remove owner access. Keep the unpublished inode private and
    // reopenable until the published name has been identity-fenced.
    fsSync.fchmodSync(tempFd, 0o600);
    await writeNativeInput(tempFd, params.input, params.maxBytes, params.assertBeforeMutation);
    if (params.sync !== false) syncFileBestEffortSync(tempFd);
    if (params.input.kind === "file") await params.input.verifySource();
    assertFinalSymlinkRejected(path.join(parentPath, params.basename), params.rejectFinalSymlink);
    params.assertBeforeMutation?.();
    if (params.overwrite === false) {
      binding.renameNoReplace(parentFd, tempName, parentFd, params.basename);
    } else {
      binding.renameReplace(parentFd, tempName, parentFd, params.basename);
    }
    renamed = true;
    params.onPublished?.(verificationIdentity);
    targetFd = binding.openBeneath(
      parentFd,
      params.basename,
      nativeOpenFlags(fsSync.constants.O_RDONLY),
    ).fd;
    const targetStat = inspectFileIdentitySync(
      () => fsSync.fstatSync(targetFd!, { bigint: true }), verificationIdentity,
    );
    const targetIdentity = binding.fstatIdentity(targetFd);
    if (!targetStat.isFile()) {
      throw new FsSafeError("path-mismatch", "native write target changed after rename");
    }
    // Native exclusive creation starts at 0600. Apply the requested mode only
    // after reopening and fencing the published name, both so mode 000 stays
    // verifiable and so broader modes are never exposed before that fence.
    try {
      fsSync.fchmodSync(targetFd, params.mode);
      if (params.sync !== false) syncFileBestEffortSync(targetFd);
    } catch (error) {
      closeWriteFd(closeFd, targetFd);
      targetFd = undefined;
      // Staged copies and streamed creates preserve publication for caller recovery.
      if (params.input.kind === "buffer" ||
        (params.input.kind === "stream" && !params.input.stageBeforePublish)) {
        removeNativeCreatedFileIfStillPinned({
          parentPath,
          parentFd,
          basename: params.basename,
          created: tempIdentity,
        });
      }
      throw error;
    }
    if (params.sync !== false) syncFileBestEffortSync(parentFd);
    // Verification follows publication and final chmod, outside rollback handling.
    await params.verifyPublished?.(targetFd, verificationIdentity, parentGuard);
    completed = true;
    return { dev: targetIdentity.dev, ino: targetIdentity.ino };
  } finally {
    const targetCloseFailure = closeWriteFd(closeFd, targetFd);
    const tempCloseFailure = closeWriteFd(closeFd, tempFd);
    if (!renamed) {
      removeNativeCreatedFileIfStillPinned({
        parentPath,
        parentFd,
        basename: tempName,
        created: tempIdentity,
      });
    }
    const parentCloseFailure = closeWriteFd(closeFd, parentFd);
    await root.close().catch(() => undefined);
    const closeFailure = targetCloseFailure ?? tempCloseFailure ?? parentCloseFailure;
    if (completed && closeFailure) throw closeFailure.error;
  }
}
