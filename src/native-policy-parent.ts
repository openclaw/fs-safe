import fsSync, { type BigIntStats } from "node:fs";
import path from "node:path";
import {
  inspectDirectoryIdentity,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import type { NativeRootAdmission } from "./native-parent-admission.js";
import { NativePolicyDirectoryMismatch } from "./native-policy-directory-observation.js";
import {
  assertWindowsPolicyParentCurrent,
  closeWindowsPolicyParentAfterFailure,
  openWindowsPolicyParent,
  windowsParentObservation,
} from "./native-policy-parent-windows.js";
import type {
  PinnedWriteParams,
  PinnedMutationAdmissionReceipt,
  PinnedMutationAuthorizationToken,
  PinnedMutationParentRequest,
  PinnedMutationParentWalkSession,
  PinnedCreatedDirectoryReceipt,
} from "./pinned-write-types.js";
import {
  assertPolicyStagedDirectoryCurrent,
  assertStagedDirectoryCurrent,
  describePolicyStagedDirectory,
  describeStagedDirectory,
  refreshPolicyStagedDirectoryObservation,
  type PolicyStagedDirectory,
} from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { realpathSync } from "./realpath.js";
import { errorCauseOptions } from "./root-errors.js";
import { isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import {
  checkedMutationDirectory,
  type MutationDirectoryObservation,
} from "./pinned-mutation-observation.js";
import { createPathSegmentRoute, joinPathSegmentRoute } from "./path-segment-route.js";
import { canReuseParentWithMutationAssertion } from "./root-write-lock-binding.js";

export type NativePolicyParent = {
  fd: number;
  guard: AsyncDirectoryGuard<BigIntStats>;
  observation: MutationDirectoryObservation;
  stagedDirectory?: ReturnType<typeof describeStagedDirectory>;
  policyDirectory?: PolicyStagedDirectory;
};

function sameAbsolutePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function mkdirPosixPolicyChild(
  binding: NativeBinding,
  parentFd: number,
  basename: string,
): boolean {
  if (!basename || basename === "." || basename === ".." || basename.includes("/") ||
    basename.includes("\0") || (process.platform === "win32" && basename.includes("\\"))) {
    throw new FsSafeError("invalid-path", "native parent creation requires one direct-child basename");
  }
  const mkdirChild = binding.mkdirChildBeneath;
  if (typeof mkdirChild === "function") {
    const created = mkdirChild.call(binding, parentFd, basename, 0o777);
    if (typeof created === "boolean") return created;
  }
  binding.mkdirBeneath(parentFd, basename, 0o777);
  return false;
}

function normalizePosixParentOpenError(error: unknown, params: PinnedWriteParams): unknown {
  if (!isSymlinkOpenError(error)) return error;
  return params.mutationAdmission?.rejectParentSymlinks
    ? new FsSafeError("symlink", "symlink path component not allowed", errorCauseOptions(error))
    : new FsSafeError("path-mismatch", "native write parent changed during policy admission", errorCauseOptions(error));
}

async function describePosixParent(fd: number, pathname: string): Promise<NativePolicyParent> {
  const parentPath = realpathSync.native(pathname);
  const stagedDirectory = describeStagedDirectory(fd, parentPath);
  const stat = await inspectDirectoryIdentity(
    parentPath,
    inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true })),
  );
  return {
    fd,
    guard: { dir: parentPath, realPath: parentPath, stat },
    stagedDirectory,
    observation: checkedMutationDirectory(parentPath, stagedDirectory.realPath, stat),
  };
}

function tryDescribePolicyPosixParent(
  binding: NativeBinding,
  fd: number,
  pathname: string,
): NativePolicyParent | undefined {
  try {
    const policyDirectory = describePolicyStagedDirectory(fd, pathname, binding);
    return {
      fd,
      guard: {
        dir: policyDirectory.directory.realPath,
        realPath: policyDirectory.directory.realPath,
        stat: policyDirectory.stat,
      },
      stagedDirectory: policyDirectory.directory,
      observation: policyDirectory.observation,
      policyDirectory,
    };
  } catch (error) {
    if (!(error instanceof FsSafeError) || error instanceof NativePolicyDirectoryMismatch ||
      (error.code !== "path-mismatch" && error.code !== "not-file")) throw error;
    return undefined;
  }
}

export async function capturePolicyAwareNativeParent(
  binding: NativeBinding,
  params: PinnedWriteParams,
  rootAdmission: NativeRootAdmission,
  windows: boolean,
  directoryFlags: number,
): Promise<NativePolicyParent> {
  const rootFd = rootAdmission.root.fd;
  const closeFd = captureNativeFdClose(binding);
  const observationDisposers = windows ? undefined : new Map<number, () => void>();
  const disposeObservation = (fd: number) => {
    const dispose = observationDisposers?.get(fd);
    observationDisposers?.delete(fd);
    dispose?.();
  };
  using observationScope = {
    [Symbol.dispose]() { for (const dispose of observationDisposers?.values() ?? []) dispose(); },
  };
  const capturePolicyParent = (fd: number, pathname: string) => {
    const captured = tryDescribePolicyPosixParent(binding, fd, pathname);
    const dispose = captured?.policyDirectory?.disposeObservation;
    if (dispose) observationDisposers!.set(fd, dispose);
    return captured;
  };
  const assertCurrent = (parent: NativePolicyParent) => windows
    ? assertWindowsPolicyParentCurrent(parent)
    : parent.policyDirectory
      ? assertPolicyStagedDirectoryCurrent(parent.policyDirectory)
      : assertStagedDirectoryCurrent(parent.stagedDirectory!);
  const closeAfterFailure = (fd: number, failure?: { error: unknown }) => {
    disposeObservation(fd);
    if (windows) closeWindowsPolicyParentAfterFailure(closeFd, fd, failure, rootAdmission.reportCloseErrors);
    else closeFd(fd);
  };
  let session: PinnedMutationParentWalkSession | undefined;
  async function authorize(
    request: PinnedMutationParentRequest,
  ): Promise<PinnedMutationAdmissionReceipt | undefined> {
    const frozen = Object.freeze(request);
    return await (session ? session.authorize(frozen) : windows
      ? params.mutationAdmission!.authorize(frozen)
      : params.mutationAdmission?.authorize(frozen));
  }
  // POSIX begins its retained observation before the complete-parent open;
  // Windows starts a walk session only after that fast path misses.
  let segments = windows ? undefined : params.relativeParentPath.split("/").filter(Boolean);
  let route = segments && createPathSegmentRoute(segments);
  let initialTarget = route && joinPathSegmentRoute(params.rootPath, route, 0, params.basename);
  const parentSpelling = segments?.length ? path.join(params.rootPath, ...segments) : params.rootPath;
  let retainedTargetPath = windows ? undefined : params.mutationAdmission?.beginParentWalk?.();
  if (retainedTargetPath && !sameAbsolutePath(retainedTargetPath, initialTarget!)) {
    retainedTargetPath = undefined;
  }
  let complete: NativePolicyParent | undefined;
  let completeFd: number | undefined;
  try {
    if (windows) {
      complete = await openWindowsPolicyParent(
        binding, params, rootAdmission, rootFd, params.rootPath, params.relativeParentPath,
      );
      completeFd = complete.fd;
    } else {
      completeFd = binding.openBeneath(rootFd, params.relativeParentPath, directoryFlags).fd;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !params.mkdir) {
      if (windows) throw error;
      await authorize({ targetPath: initialTarget!, mutationPath: initialTarget!, phase: "parent" });
      throw normalizePosixParentOpenError(error, params);
    }
  }
  if (completeFd !== undefined) {
    try {
      complete ??= retainedTargetPath ? capturePolicyParent(completeFd, parentSpelling) : undefined;
      if (!complete) {
        retainedTargetPath = undefined;
        complete = await describePosixParent(completeFd, parentSpelling);
      }
      const targetPath = path.join(complete.guard.realPath, params.basename);
      await authorize({ targetPath, mutationPath: targetPath, phase: "parent" });
      assertCurrent(complete);
      return complete;
    } catch (error) {
      closeAfterFailure(completeFd, { error });
      throw error;
    }
  }
  segments ??= params.relativeParentPath.split("/").filter(Boolean);
  route ??= createPathSegmentRoute(segments);
  let current: NativePolicyParent;
  if (windows) {
    const rootStat = inspectDirectoryIdentitySync(params.rootPath, inspectFileIdentitySync(
      () => fsSync.fstatSync(rootFd, { bigint: true }),
    ));
    const guard = { dir: params.rootPath, realPath: params.rootPath, stat: rootStat };
    current = { fd: rootFd, guard, observation: windowsParentObservation(binding, rootFd, guard) };
  } else {
    const captured = retainedTargetPath ? capturePolicyParent(rootFd, params.rootPath) : undefined;
    if (!captured) retainedTargetPath = undefined;
    current = captured ?? await describePosixParent(rootFd, params.rootPath);
  }
  let ownedFd: number | undefined;
  let currentPath = params.rootPath;
  let failure: { error: unknown } | undefined;
  initialTarget ??= joinPathSegmentRoute(params.rootPath, route, 0, params.basename);
  if (windows && canReuseParentWithMutationAssertion(params.assertBeforeMutation, params.rootPath, initialTarget)) {
    session = params.mutationAdmission?.beginNativeParentWalk?.() ?? params.mutationAdmission?.beginSharedParentWalk?.();
    if (session && session.retainedTargetPath !== initialTarget) {
      session.dispose();
      session = undefined;
    }
  }
  const secureDirectoryFlags = directoryFlags | (fsSync.constants.O_NOFOLLOW ?? 0);
  try {
    if (!windows) {
      const targetPath = retainedTargetPath ?? initialTarget;
      await authorize({ targetPath, mutationPath: targetPath, phase: "parent" });
      assertCurrent(current);
    }
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      let childPath = windows ? undefined : path.join(currentPath, segment);
      let child: NativePolicyParent | undefined;
      let childFd: number;
      let createdByMkdir = false;
      let createReceipt: PinnedMutationAdmissionReceipt | undefined;
      try {
        if (windows) {
          child = await openWindowsPolicyParent(
            binding, params, rootAdmission, current.fd, currentPath, segment,
          );
          childFd = child.fd;
        } else {
          childFd = binding.openBeneath(current.fd, segment, secureDirectoryFlags).fd;
        }
      } catch (error) {
        const missing = windows
          ? (error as NodeJS.ErrnoException)?.code === "ENOENT"
          : isNotFoundPathError(error);
        if (!missing) throw windows ? error : normalizePosixParentOpenError(error, params);
        const targetPath = (windows ? session?.retainedTargetPath : retainedTargetPath) ??
          joinPathSegmentRoute(currentPath, route, index, params.basename);
        childPath ??= path.join(currentPath, segment);
        const request = Object.freeze({
          targetPath, mutationPath: childPath, phase: "parent-create" as const,
        });
        createReceipt = windows
          ? session?.tryAuthorizeAtParent(request, current.observation)
          : params.mutationAdmission?.tryAuthorizeAtParent?.(request, current.observation);
        if (!createReceipt) {
          createReceipt = await authorize(windows ? { ...request } : request);
          assertCurrent(current);
        }
        // POSIX always refreshes here; Windows refreshes only after a live callback.
        if (windows) {
          if (params.assertBeforeMutation) {
            params.assertBeforeMutation();
            assertCurrent(current);
          }
        } else {
          params.assertBeforeMutation?.();
          assertCurrent(current);
        }
        if (windows) {
          const mkdirChild = binding.mkdirChildBeneath;
          if (typeof mkdirChild !== "function") {
            throw new FsSafeError("helper-unavailable", "native direct-child parent creation is unavailable");
          }
          createdByMkdir = mkdirChild.call(binding, current.fd, segment, 0o777) === true;
          child = await openWindowsPolicyParent(
            binding, params, rootAdmission, current.fd, currentPath, segment,
          );
          childFd = child.fd;
        } else {
          createdByMkdir = mkdirPosixPolicyChild(binding, current.fd, segment);
          try {
            childFd = binding.openBeneath(current.fd, segment, secureDirectoryFlags).fd;
          } catch (error) {
            throw normalizePosixParentOpenError(error, params);
          }
        }
      }
      try {
        if (!child) {
          child = retainedTargetPath ? capturePolicyParent(childFd, childPath!) : undefined;
          if (!child) {
            retainedTargetPath = undefined;
            child = await describePosixParent(childFd, childPath!);
          }
          if (!sameAbsolutePath(child.guard.realPath, childPath!)) retainedTargetPath = undefined;
        }
        const windowsTarget = windows
          ? joinPathSegmentRoute(child.guard.realPath, route, index + 1, params.basename)
          : undefined;
        if (session && windowsTarget !== session.retainedTargetPath) {
          session.dispose();
          session = undefined;
        }
        let childAuthorization: PinnedMutationAuthorizationToken | undefined;
        if (createdByMkdir && createReceipt &&
          (windows ? session : params.mutationAdmission?.advanceCreatedDirectory)) {
          let evidence: PinnedCreatedDirectoryReceipt | undefined;
          try {
            const parent = windows
              ? windowsParentObservation(binding, current.fd, { ...current.guard,
                stat: inspectFileIdentitySync(() => fsSync.fstatSync(current.fd, { bigint: true }), current.guard.stat),
              })
              : current.policyDirectory
                ? refreshPolicyStagedDirectoryObservation(current.policyDirectory)
                : checkedMutationDirectory(
                  currentPath,
                  current.stagedDirectory!.realPath,
                  assertStagedDirectoryCurrent(current.stagedDirectory!),
                );
            evidence = Object.freeze({
              admission: createReceipt,
              parent,
              child: child.observation,
            });
          } catch {
            // Failed optional evidence falls back to the existing ordered admission.
          }
          if (evidence) {
            childAuthorization = windows
              ? session!.advanceCreatedDirectory(evidence)
              : params.mutationAdmission!.advanceCreatedDirectory!(evidence);
          }
        }
        const targetPath = windowsTarget ?? retainedTargetPath ??
          joinPathSegmentRoute(child.guard.realPath, route, index + 1, params.basename);
        if (!windows || !childAuthorization) {
          const request = {
            targetPath, mutationPath: targetPath, phase: "parent" as const,
          };
          if (!windows) {
            Object.freeze(request);
            childAuthorization ??= params.mutationAdmission?.tryAuthorizeAtParent?.(
              request,
              child.observation,
            );
          }
          if (!childAuthorization) {
            await authorize(request);
            assertCurrent(child);
          }
        }
      } catch (error) {
        closeAfterFailure(childFd, { error });
        throw error;
      }
      const previousFd = ownedFd;
      disposeObservation(current.fd);
      current = child;
      ownedFd = child.fd;
      currentPath = child.guard.realPath;
      if (previousFd !== undefined) closeFd(previousFd);
    }
    if (ownedFd === undefined) {
      throw new FsSafeError("path-mismatch", "native write parent admission did not complete");
    }
    ownedFd = undefined;
    return current;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    session?.dispose();
    if (ownedFd !== undefined) closeAfterFailure(ownedFd, failure);
  }
}
