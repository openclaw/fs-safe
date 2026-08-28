import { randomUUID } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import {
  nativeOpenFlags,
  removeNativeCreatedFileIfStillPinned,
  syncNativeFileBestEffort,
  writeNativeInput,
} from "./native-operations.js";
import type { NativeBinding } from "./native.js";
import type { PinnedWriteParams } from "./pinned-write.js";

export function sameNativeIdentity(
  left: Pick<FileIdentityStat, "dev" | "ino">,
  right: Pick<FileIdentityStat, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeWriteFd(fd: number | undefined): unknown {
  if (fd === undefined) return;
  try {
    fsSync.closeSync(fd);
  } catch (error) {
    return error;
  }
}

export async function runPinnedWriteWindows(
  binding: NativeBinding,
  params: PinnedWriteParams,
  root: FileHandle,
  parentFd: number,
  parentGuard: AsyncDirectoryGuard,
): Promise<FileIdentityStat> {
  const parentPath = parentGuard.realPath;
  let tempFd: number | undefined;
  let targetFd: number | undefined;
  let tempIdentity: Stats | undefined;
  let tempName = "";
  let renamed = false;
  let completed = false;
  try {
    tempName = `.${params.basename}.${randomUUID()}.native.tmp`;
    tempFd = binding.openBeneath(
      parentFd,
      tempName,
      nativeOpenFlags(
        fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
      ),
    ).fd;
    tempIdentity = fsSync.fstatSync(tempFd);
    const verificationIdentity = fsSync.fstatSync(tempFd, { bigint: true });
    // Creation is requested at 0600 in the binding, but a restrictive umask
    // can remove owner access. Keep the unpublished inode private and
    // reopenable until the published name has been identity-fenced.
    fsSync.fchmodSync(tempFd, 0o600);
    await writeNativeInput(tempFd, params.input, params.maxBytes);
    syncNativeFileBestEffort(tempFd);
    if (params.overwrite === false) {
      binding.renameNoReplace(parentFd, tempName, parentFd, params.basename);
    } else {
      binding.renameReplace(parentFd, tempName, parentFd, params.basename);
    }
    renamed = true;
    targetFd = binding.openBeneath(
      parentFd,
      params.basename,
      nativeOpenFlags(fsSync.constants.O_RDONLY),
    ).fd;
    const targetIdentity = binding.fstatIdentity(targetFd);
    if (!targetIdentity.isFile || !sameNativeIdentity(tempIdentity, targetIdentity)) {
      throw new FsSafeError("path-mismatch", "native write target changed after rename");
    }
    // Native exclusive creation starts at 0600. Apply the requested mode only
    // after reopening and fencing the published name, both so mode 000 stays
    // verifiable and so broader modes are never exposed before that fence.
    try {
      fsSync.fchmodSync(targetFd, params.mode);
      syncNativeFileBestEffort(targetFd);
    } catch (error) {
      closeWriteFd(targetFd);
      targetFd = undefined;
      removeNativeCreatedFileIfStillPinned({
        binding,
        parentPath,
        parentFd,
        basename: params.basename,
        created: tempIdentity,
      });
      throw error;
    }
    syncNativeFileBestEffort(parentFd);
    // Verification follows publication and final chmod, outside rollback handling.
    await params.verifyPublished?.(targetFd, verificationIdentity, parentGuard);
    completed = true;
    return { dev: targetIdentity.dev, ino: targetIdentity.ino };
  } finally {
    const targetCloseError = closeWriteFd(targetFd);
    const tempCloseError = closeWriteFd(tempFd);
    if (!renamed) {
      removeNativeCreatedFileIfStillPinned({
        binding,
        parentPath,
        parentFd,
        basename: tempName,
        created: tempIdentity,
      });
    }
    const parentCloseError = closeWriteFd(parentFd);
    await root.close().catch(() => undefined);
    const closeError = targetCloseError ?? tempCloseError ?? parentCloseError;
    if (completed && closeError !== undefined) throw closeError;
  }
}
