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
import { inspectNativeDirectoryObservation, type NativeDirectoryObservationBackend } from "./native-directory-observation.js";
import { createPathSegmentRoute, joinPathSegmentRoute } from "./path-segment-route.js";
import { isSymlinkOpenError } from "./path.js";
import type { PinnedWriteParams, PinnedMutationAdmissionReceipt, PinnedMutationParentWalkSession, PinnedCreatedDirectoryReceipt } from "./pinned-write.js";
import { checkedMutationDirectory, type MutationDirectoryObservation } from "./pinned-mutation-observation.js";
import { canReuseParentWithMutationAssertion } from "./root-write-lock-binding.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

type PolicyParent = {
  fd: number;
  guard: AsyncDirectoryGuard<BigIntStats>;
  observation: MutationDirectoryObservation;
};

function assertParentCurrent(parent: PolicyParent): BigIntStats {
  const current = inspectFileIdentitySync(() => fsSync.fstatSync(parent.fd, { bigint: true }), parent.guard.stat);
  assertDirectoryIdentitySync(parent.guard.dir, {
    dev: parent.guard.stat.dev,
    ino: parent.guard.stat.ino,
    realPath: parent.guard.realPath,
  });
  return current;
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
  let session: PinnedMutationParentWalkSession | undefined;
  function parentObservation(fd: number, guard: AsyncDirectoryGuard<BigIntStats>) {
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
  async function openParent(fd: number, parentPath: string, relativePath: string): Promise<PolicyParent> {
    try {
      const admitted = await openNativeParentAdmission(binding, {
        ...rootAdmission,
        root: { fd },
        rootPath: parentPath,
        // Policy fences retain every identity bit even with a legacy numeric root.
        exactRoot: true,
      }, relativePath, "native-directory");
      const guard = { ...admitted.guard, stat: admitted.guard.stat as BigIntStats };
      return { fd: admitted.fd, guard, observation: parentObservation(admitted.fd, guard) };
    } catch (error) {
      if (!isSymlinkOpenError(error)) throw error;
      throw new FsSafeError(
        params.mutationAdmission!.rejectParentSymlinks ? "symlink" : "path-mismatch",
        "native write parent changed during policy admission",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async function authorize(
    targetPath: string,
    mutationPath = targetPath,
    phase: "parent" | "parent-create" = "parent",
  ): Promise<PinnedMutationAdmissionReceipt | undefined> {
    const request = Object.freeze({ targetPath, mutationPath, phase });
    return await (session ? session.authorize(request) : params.mutationAdmission!.authorize(request));
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
  const rootStat = inspectDirectoryIdentitySync(params.rootPath, inspectFileIdentitySync(
    () => fsSync.fstatSync(rootAdmission.root.fd, { bigint: true }),
  ));
  let current: PolicyParent = {
    fd: rootAdmission.root.fd,
    guard: { dir: params.rootPath, realPath: params.rootPath, stat: rootStat },
    observation: parentObservation(rootAdmission.root.fd, {
      dir: params.rootPath, realPath: params.rootPath, stat: rootStat,
    }),
  };
  let ownedFd: number | undefined;
  const initialTarget = joinPathSegmentRoute(params.rootPath, route, 0, params.basename);
  if (canReuseParentWithMutationAssertion(params.assertBeforeMutation, params.rootPath, initialTarget)) {
    session = params.mutationAdmission?.beginNativeParentWalk?.() ??
      params.mutationAdmission?.beginSharedParentWalk?.();
    if (session && session.retainedTargetPath !== initialTarget) {
      session.dispose();
      session = undefined;
    }
  }
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const parentPath = current.guard.realPath;
      let child: PolicyParent;
      let createdByMkdir = false;
      let createReceipt: PinnedMutationAdmissionReceipt | undefined;
      try {
        child = await openParent(current.fd, parentPath, segment);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        // The request admits both the prospective leaf and this missing direct
        // child. A deeper denial can leave already admitted ancestors intact.
        const targetPath = session?.retainedTargetPath ??
          joinPathSegmentRoute(parentPath, route, index, params.basename);
        const mutationPath = path.join(parentPath, segment);
        const request = Object.freeze({ targetPath, mutationPath, phase: "parent-create" as const });
        createReceipt = session?.tryAuthorizeAtParent(request, current.observation);
        if (!createReceipt) {
          createReceipt = await authorize(targetPath, mutationPath, "parent-create");
          assertParentCurrent(current);
        }
        if (params.assertBeforeMutation) {
          // Opaque callbacks retain their post-callback descriptor/path fence.
          params.assertBeforeMutation();
          assertParentCurrent(current);
        }
        // Synchronous session admission already ends at the exact parent fence.
        const mkdirChild = binding.mkdirChildBeneath;
        if (typeof mkdirChild !== "function") {
          throw new FsSafeError("helper-unavailable", "native direct-child parent creation is unavailable");
        }
        createdByMkdir = mkdirChild.call(binding, current.fd, segment, 0o777) === true;
        child = await openParent(current.fd, parentPath, segment);
      }
      try {
        const targetPath = joinPathSegmentRoute(child.guard.realPath, route, index + 1, params.basename);
        if (session && targetPath !== session.retainedTargetPath) {
          session.dispose();
          session = undefined;
        }
        let evidence: PinnedCreatedDirectoryReceipt | undefined;
        if (session && createdByMkdir && createReceipt) {
          try {
            evidence = Object.freeze({
              admission: createReceipt,
              parent: parentObservation(current.fd, { ...current.guard,
                stat: inspectFileIdentitySync(() => fsSync.fstatSync(current.fd, { bigint: true }), current.guard.stat),
              }),
              child: child.observation,
            });
          } catch {
            // Incomplete optional evidence returns to ordered admission below.
          }
        }
        // Advancement refreshes both named directories after all Root/policy
        // observations; these receipts supply expectations, not cached authority.
        const advanced = evidence && session!.advanceCreatedDirectory(evidence);
        if (!advanced) {
          await authorize(targetPath);
          assertParentCurrent(child);
        }
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
    session?.dispose();
    closeAfterFailure(closeFd, ownedFd);
  }
}
