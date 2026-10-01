import fsSync, { type BigIntStats } from "node:fs";
import {
  assertDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { openNativeParentAdmission, type NativeRootAdmission } from "./native-parent-admission.js";
import type { NativeBinding } from "./native.js";
import { inspectNativeDirectoryObservation, type NativeDirectoryObservationBackend } from "./native-directory-observation.js";
import { isSymlinkOpenError } from "./path.js";
import type { PinnedWriteParams } from "./pinned-write-types.js";
import { checkedMutationDirectory, type MutationDirectoryObservation } from "./pinned-mutation-observation.js";
import type { NativePolicyParent } from "./native-policy-parent.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";

export function assertWindowsPolicyParentCurrent(parent: NativePolicyParent): void {
  inspectFileIdentitySync(() => fsSync.fstatSync(parent.fd, { bigint: true }), parent.guard.stat);
  assertDirectoryIdentitySync(parent.guard.dir, {
    dev: parent.guard.stat.dev,
    ino: parent.guard.stat.ino,
    realPath: parent.guard.realPath,
  });
}

export function closeWindowsPolicyParentAfterFailure(
  closeFd: (fd: number) => void,
  fd: number,
  failure?: { error: unknown },
  report = false,
): void {
  try {
    closeFd(fd);
  } catch (error) {
    if (report) throw failure
      ? createSuppressedError(error, failure.error, "native parent admission and close failed")
      : error;
  }
}

export function windowsParentObservation(binding: NativeBinding, fd: number, guard: AsyncDirectoryGuard<BigIntStats>): MutationDirectoryObservation {
  return checkedMutationDirectory(guard.dir, guard.realPath, guard.stat,
    typeof binding.observeDirectory === "function" ? () => {
      const stat = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), guard.stat);
      let observed;
      try {
        observed = inspectNativeDirectoryObservation(
          binding as NativeDirectoryObservationBackend, guard.dir, stat,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "OBSERVATION_UNAVAILABLE") return undefined;
        throw error;
      }
      return { canonicalPath: observed.realPath,
        identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink } };
    } : undefined);
}

export async function openWindowsPolicyParent(
  binding: NativeBinding,
  params: PinnedWriteParams,
  rootAdmission: NativeRootAdmission,
  fd: number,
  parentPath: string,
  relativePath: string,
): Promise<NativePolicyParent> {
  try {
    const admitted = await openNativeParentAdmission(binding, {
      ...rootAdmission,
      root: { fd },
      rootPath: parentPath,
      // Policy fences retain every identity bit even with a legacy numeric root.
      exactRoot: true,
    }, relativePath, "native-directory");
    const guard = { ...admitted.guard, stat: admitted.guard.stat as BigIntStats };
    return { fd: admitted.fd, guard, observation: windowsParentObservation(binding, admitted.fd, guard) };
  } catch (error) {
    if (!isSymlinkOpenError(error)) throw error;
    throw new FsSafeError(
      params.mutationAdmission!.rejectParentSymlinks ? "symlink" : "path-mismatch",
      "native write parent changed during policy admission",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}
