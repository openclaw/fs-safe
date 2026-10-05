import fsSync, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows } from "./native-pinned-write-windows.js";
import { capturePolicyAwareNativeParent } from "./native-policy-parent.js";
import { openNativeParentAdmission, openNativeRootAdmission } from "./native-parent-admission.js";
import { assertNativeStaging, writeNativeStage, type NativeStagingBinding } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import type { PinnedWriteParams } from "./pinned-write-types.js";
import { cachedNoReplaceUnavailable } from "./native-noreplace.js";
import { isFsSafeNativeRequired } from "./native-config.js";
import type { describeStagedDirectory } from "./staged-directory.js";

export async function runPinnedWriteNative(
  binding: NativeBinding, params: PinnedWriteParams,
  fallback: (input: PinnedWriteParams["input"]) => Promise<FileIdentityStat>,
): Promise<FileIdentityStat> {
  const closeFd = captureNativeFdClose(binding);
  const windows = process.platform === "win32";
  if (!windows) {
    assertNativeStaging(binding);
  }
  const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
  const completeCreate = params.overwrite === false && params.input.kind !== "file" && params.input.stageBeforePublish === true;
  const rootAdmission = await openNativeRootAdmission(binding, {
    rootPath: params.rootPath,
    rootIdentity: params.rootIdentity,
    operation: "native write",
    reportCloseErrors: completeCreate,
  });
  const root = rootAdmission.root;
  await using posixRoot = windows ? undefined : root;
  let parentFd: number | undefined;
  let windowsOwnsDirectories = false;
  let admissionFailure: { error: unknown } | undefined;
  // Until stage construction takes ownership, even admission failures must close
  // the raw POSIX parent. Disposal preserves both admission and close failures.
  using parentGuard = {
    [Symbol.dispose]() {
      if (!windows && parentFd !== undefined) {
        closeFd(parentFd);
      }
    },
  };
  try {
    let parentPath: string;
    let directory: ReturnType<typeof describeStagedDirectory> | undefined;
    let parentPathStat: Stats | BigIntStats;
    if (params.mutationAdmission) {
      const admitted = await capturePolicyAwareNativeParent(
        binding, params, rootAdmission, windows, directoryFlags,
      );
      parentFd = admitted.fd;
      parentPath = admitted.guard.realPath;
      directory = admitted.stagedDirectory;
      parentPathStat = admitted.guard.stat;
    } else {
      if (params.mkdir) {
        params.assertBeforeMutation?.();
        binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
      }
      const admitted = await openNativeParentAdmission(binding, rootAdmission, params.relativeParentPath);
      parentFd = admitted.fd;
      parentPath = admitted.guard.realPath;
      directory = admitted.stagedDirectory;
      parentPathStat = admitted.guard.stat;
    }
    const verificationGuard = { dir: parentPath, realPath: parentPath, stat: parentPathStat };
    if (params.overwrite === false) {
      try {
        fsSync.lstatSync(path.join(parentPath, params.basename));
        throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (windows) {
      // The Windows leaf owns both directories after admission.
      windowsOwnsDirectories = true;
      return await runPinnedWriteWindows(binding, params, root, parentFd, verificationGuard);
    }
    if (params.overwrite === false && !(params.input.kind === "buffer" && params.input.stageBeforePublish === false)) {
      const unavailable = cachedNoReplaceUnavailable(binding, parentFd);
      if (unavailable) {
        if (isFsSafeNativeRequired() || (params.input.kind === "file" && params.input.clone === "always")) throw unavailable;
        return await fallback(params.input);
      }
    }
    const ownedParent = parentFd;
    parentFd = undefined;
    return await writeNativeStage(
      binding as NativeStagingBinding, ownedParent, closeFd, directory!, params, verificationGuard, fallback,
    );
  } catch (error) {
    admissionFailure = { error };
    throw error;
  } finally {
    if (windows && !windowsOwnsDirectories) {
      const closeErrors: unknown[] = [];
      if (parentFd !== undefined) {
        // Match the Windows leaf cleanup contract: an admission or identity
        // failure remains primary, while every owned directory is still given
        // a close attempt. In particular, a parent close failure must not skip
        // the root FileHandle close.
        try {
          closeFd(parentFd);
        } catch (error) {
          closeErrors.push(error);
        }
      }
      try {
        await root.close();
      } catch (error) {
        closeErrors.push(error);
      }
      if (completeCreate && closeErrors.length > 0) {
        throw new AggregateError(
          [...(admissionFailure ? [admissionFailure.error] : []), ...closeErrors],
          "native create admission and close failed",
        );
      }
    }
  }
}
