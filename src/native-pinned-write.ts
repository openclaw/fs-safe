import fsSync from "node:fs";
import path from "node:path";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows } from "./native-pinned-write-windows.js";
import { openNativeParentAdmission, openNativeRootAdmission } from "./native-parent-admission.js";
import { assertNativeStaging, writeNativeStage, type NativeStagingBinding } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import type { PinnedWriteParams } from "./pinned-write.js";

export async function runPinnedWriteNative(binding: NativeBinding, params: PinnedWriteParams): Promise<FileIdentityStat> {
  const windows = process.platform === "win32";
  if (!windows) {
    assertNativeStaging(binding);
  }
  const rootAdmission = await openNativeRootAdmission(binding, {
    rootPath: params.rootPath,
    rootIdentity: params.rootIdentity,
    operation: "native write",
  });
  const root = rootAdmission.root;
  await using posixRoot = windows ? undefined : root;
  let parentFd: number | undefined;
  let windowsOwnsDirectories = false;
  // Until stage construction takes ownership, even admission failures must close
  // the raw POSIX parent. Disposal preserves both admission and close failures.
  using parentGuard = {
    [Symbol.dispose]() {
      if (!windows && parentFd !== undefined) {
        fsSync.closeSync(parentFd);
      }
    },
  };
  try {
    if (params.mkdir) {
      params.assertBeforeMutation?.();
      binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
    }
    const parent = await openNativeParentAdmission(
      binding,
      rootAdmission,
      params.relativeParentPath,
    );
    parentFd = parent.fd;
    const verificationGuard = parent.guard;
    if (params.overwrite === false) {
      try {
        fsSync.lstatSync(path.join(parent.guard.realPath, params.basename));
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
    const ownedParent = parentFd;
    parentFd = undefined;
    return await writeNativeStage(
      binding as NativeStagingBinding, ownedParent, parent.stagedDirectory!, params, verificationGuard,
    );
  } finally {
    if (windows && !windowsOwnsDirectories) {
      if (parentFd !== undefined) {
        fsSync.closeSync(parentFd);
      }
      await root.close().catch(() => undefined);
    }
  }
}
