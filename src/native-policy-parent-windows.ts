import fsSync, { type BigIntStats } from "node:fs";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { openNativeParentAdmission, type NativeRootAdmission } from "./native-parent-admission.js";
import type { NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { createPathSegmentRoute, joinPathSegmentRoute } from "./path-segment-route.js";
import { isSymlinkOpenError } from "./path.js";
import type { PinnedWriteParams } from "./pinned-write.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

type PolicyParent = {
  fd: number;
  guard: AsyncDirectoryGuard<BigIntStats>;
};

function assertParentCurrent(parent: PolicyParent): void {
  inspectFileIdentitySync(() => fsSync.fstatSync(parent.fd, { bigint: true }), parent.guard.stat);
  assertDirectoryIdentitySync(parent.guard.dir, {
    dev: parent.guard.stat.dev,
    ino: parent.guard.stat.ino,
    realPath: parent.guard.realPath,
  });
}

function closeAfterFailure(closeFd: (fd: number) => void, fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeFd(fd);
  } catch {
    // Windows retains the operation failure while attempting every owned close.
  }
}

export async function capturePolicyAwareWindowsParent(
  binding: NativeBinding,
  params: PinnedWriteParams,
  rootAdmission: NativeRootAdmission,
): Promise<PolicyParent> {
  const closeFd = captureNativeFdClose(binding);
  async function openParent(fd: number, parentPath: string, relativePath: string): Promise<PolicyParent> {
    const admitted = await openNativeParentAdmission(binding, {
      ...rootAdmission,
      root: { fd },
      rootPath: parentPath,
      // Policy fences retain every identity bit even with a legacy numeric root.
      exactRoot: true,
    }, relativePath);
    return {
      fd: admitted.fd,
      guard: { ...admitted.guard, stat: admitted.guard.stat as BigIntStats },
    };
  }

  async function authorize(
    targetPath: string,
    mutationPath = targetPath,
    phase: "parent" | "parent-create" = "parent",
  ): Promise<void> {
    await params.mutationAdmission!.authorize(Object.freeze({ targetPath, mutationPath, phase }));
  }

  async function openChild(parent: PolicyParent, segment: string): Promise<PolicyParent> {
    try {
      return await openParent(parent.fd, parent.guard.realPath, segment);
    } catch (error) {
      if (!isSymlinkOpenError(error)) throw error;
      throw new FsSafeError(
        params.mutationAdmission!.rejectParentSymlinks ? "symlink" : "path-mismatch",
        "native write parent changed during policy admission",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  // Existing complete parents need one open and one target admission. Exact
  // parent denies apply only to creation, never to merely using a directory.
  let complete: PolicyParent | undefined;
  try {
    complete = await openParent(rootAdmission.root.fd, params.rootPath, params.relativeParentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !params.mkdir) throw error;
  }
  if (complete) {
    try {
      await authorize(path.join(complete.guard.realPath, params.basename));
      assertParentCurrent(complete);
      return complete;
    } catch (error) {
      closeAfterFailure(closeFd, complete.fd);
      throw error;
    }
  }

  const segments = params.relativeParentPath.split("/").filter(Boolean);
  const route = createPathSegmentRoute(segments);
  let current: PolicyParent = {
    fd: rootAdmission.root.fd,
    guard: {
      dir: params.rootPath,
      realPath: params.rootPath,
      stat: inspectDirectoryIdentitySync(params.rootPath, inspectFileIdentitySync(
        () => fsSync.fstatSync(rootAdmission.root.fd, { bigint: true }),
      )),
    },
  };
  let ownedFd: number | undefined;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const parentPath = current.guard.realPath;
      let child: PolicyParent;
      try {
        child = await openChild(current, segment);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        // The request admits both the prospective leaf and this missing direct
        // child. A deeper denial can leave already admitted ancestors intact.
        await authorize(
          joinPathSegmentRoute(parentPath, route, index, params.basename),
          path.join(parentPath, segment),
          "parent-create",
        );
        assertParentCurrent(current);
        params.assertBeforeMutation?.();
        // Authority callbacks can change paths; no await separates this fence
        // from descriptor-relative creation through the retained parent.
        assertParentCurrent(current);
        const mkdirChild = binding.mkdirChildBeneath;
        if (typeof mkdirChild !== "function") {
          throw new FsSafeError("helper-unavailable", "native direct-child parent creation is unavailable");
        }
        mkdirChild.call(binding, current.fd, segment, 0o777);
        child = await openChild(current, segment);
      }
      try {
        await authorize(joinPathSegmentRoute(child.guard.realPath, route, index + 1, params.basename));
        assertParentCurrent(child);
      } catch (error) {
        closeAfterFailure(closeFd, child.fd);
        throw error;
      }
      const previousFd = ownedFd;
      current = child;
      ownedFd = child.fd;
      if (previousFd !== undefined) closeFd(previousFd);
    }
    if (ownedFd === undefined) {
      throw new FsSafeError("path-mismatch", "native write parent admission did not complete");
    }
    ownedFd = undefined;
    return current;
  } finally {
    closeAfterFailure(closeFd, ownedFd);
  }
}
