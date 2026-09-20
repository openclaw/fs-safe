import fsSync, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentity } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows } from "./native-pinned-write-windows.js";
import { capturePolicyAwareWindowsParent } from "./native-policy-parent-windows.js";
import { openNativeParentAdmission, openNativeRootAdmission } from "./native-parent-admission.js";
import { assertNativeStaging, writeNativeStage, type NativeStagingBinding } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import type { PinnedMutationParentRequest } from "./pinned-write-types.js";
import { captureNativeFdClose } from "./native-binding.js";
import { NativePolicyDirectoryMismatch } from "./native-policy-directory-observation.js";
import type {
  PinnedCreatedDirectoryReceipt,
  PinnedMutationAdmissionReceipt,
  PinnedMutationAuthorizationToken,
  PinnedWriteParams,
} from "./pinned-write.js";
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
import { isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import {
  checkedMutationDirectory,
  type MutationDirectoryObservation,
} from "./pinned-mutation-observation.js";
import { createPathSegmentRoute, joinPathSegmentRoute } from "./path-segment-route.js";

type PosixParentAdmission = {
  parentFd: number;
  parentPath: string;
  directory: ReturnType<typeof describeStagedDirectory>;
  parentPathStat: BigIntStats;
  observation: MutationDirectoryObservation;
  policyDirectory?: PolicyStagedDirectory;
};

function sameAbsolutePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function assertDirectChildBasename(basename: string): void {
  if (!basename || basename === "." || basename === ".." || basename.includes("/") ||
    basename.includes("\0") || (process.platform === "win32" && basename.includes("\\"))) {
    throw new FsSafeError("invalid-path", "native parent creation requires one direct-child basename");
  }
}

function mkdirPolicyChild(
  binding: NativeBinding,
  parentFd: number,
  basename: string,
  mode: number,
): boolean {
  assertDirectChildBasename(basename);
  const mkdirChild = binding.mkdirChildBeneath;
  if (typeof mkdirChild === "function") {
    const created = mkdirChild.call(binding, parentFd, basename, mode);
    if (typeof created === "boolean") return created;
  }
  // Old or malformed optional helpers still execute through the established
  // recursive primitive, but cannot provide exclusive-creation provenance.
  binding.mkdirBeneath(parentFd, basename, mode);
  return false;
}

async function authorizePinnedMutation(
  params: PinnedWriteParams,
  request: PinnedMutationParentRequest,
): Promise<PinnedMutationAdmissionReceipt | undefined> {
  return await params.mutationAdmission?.authorize(Object.freeze(request));
}

function normalizePolicyParentOpenError(error: unknown, params: PinnedWriteParams): unknown {
  if (!isSymlinkOpenError(error)) return error;
  return params.mutationAdmission?.rejectParentSymlinks
    ? new FsSafeError("symlink", "symlink path component not allowed", {
      cause: error instanceof Error ? error : undefined,
    })
    : new FsSafeError("path-mismatch", "native write parent changed during policy admission", {
      cause: error instanceof Error ? error : undefined,
    });
}

async function describePosixParent(parentFd: number, pathname: string): Promise<PosixParentAdmission> {
  const parentPath = realpathSync.native(pathname);
  const directory = describeStagedDirectory(parentFd, parentPath);
  const parentPathStat = await inspectDirectoryIdentity(
    parentPath,
    inspectFileIdentitySync(() => fsSync.fstatSync(parentFd, { bigint: true })),
  );
  return {
    parentFd,
    parentPath,
    directory,
    parentPathStat,
    observation: checkedMutationDirectory(parentPath, directory.realPath, parentPathStat),
  };
}

function describePolicyPosixParent(
  binding: NativeBinding, parentFd: number, pathname: string,
): PosixParentAdmission {
  const policyDirectory = describePolicyStagedDirectory(parentFd, pathname, binding);
  return {
    parentFd,
    parentPath: policyDirectory.directory.realPath,
    directory: policyDirectory.directory,
    parentPathStat: policyDirectory.stat,
    observation: policyDirectory.observation,
    policyDirectory,
  };
}

function policyParentCaptureDeopt(error: unknown): boolean {
  return error instanceof FsSafeError &&
    !(error instanceof NativePolicyDirectoryMismatch) &&
    (error.code === "path-mismatch" || error.code === "not-file");
}

function tryDescribePolicyPosixParent(
  binding: NativeBinding,
  parentFd: number,
  pathname: string,
): PosixParentAdmission | undefined {
  try {
    return describePolicyPosixParent(binding, parentFd, pathname);
  } catch (error) {
    if (!policyParentCaptureDeopt(error)) throw error;
    return undefined;
  }
}

function assertPosixParentCurrent(parent: PosixParentAdmission): BigIntStats {
  return parent.policyDirectory
    ? assertPolicyStagedDirectoryCurrent(parent.policyDirectory)
    : assertStagedDirectoryCurrent(parent.directory);
}

async function capturePolicyAwarePosixParent(
  binding: NativeBinding,
  params: PinnedWriteParams,
  rootFd: number,
  directoryFlags: number,
): Promise<PosixParentAdmission> {
  const closeFd = captureNativeFdClose(binding);
  const observationDisposers = new Map<number, () => void>();
  const disposeObservation = (fd: number) => {
    const dispose = observationDisposers.get(fd);
    observationDisposers.delete(fd);
    dispose?.();
  };
  using observationScope = {
    [Symbol.dispose]() { for (const dispose of observationDisposers.values()) dispose(); },
  };
  const capturePolicyParent = (fd: number, pathname: string) => {
    const captured = tryDescribePolicyPosixParent(binding, fd, pathname);
    const dispose = captured?.policyDirectory?.disposeObservation;
    if (dispose) observationDisposers.set(fd, dispose);
    return captured;
  };
  const segments = params.relativeParentPath.split("/").filter(Boolean);
  const parentSpelling = segments.length
    ? path.join(params.rootPath, ...segments)
    : params.rootPath;
  const segmentRoute = createPathSegmentRoute(segments);
  const initialTarget = joinPathSegmentRoute(
    params.rootPath,
    segmentRoute,
    0,
    params.basename,
  );
  let retainedTargetPath = params.mutationAdmission?.beginParentWalk?.();
  if (retainedTargetPath && !sameAbsolutePath(retainedTargetPath, initialTarget)) {
    retainedTargetPath = undefined;
  }

  // Preserve the one-open hot path when the complete parent still exists.
  // Policy is attached only after the opened descriptor is associated with its
  // current canonical pathname, so a contained redirect cannot retain the old
  // preflight authorization.
  let completeParentFd: number | undefined;
  try {
    completeParentFd = binding.openBeneath(
      rootFd,
      params.relativeParentPath,
      directoryFlags,
    ).fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !params.mkdir) throw error;
  }
  if (completeParentFd !== undefined) {
    const parentFd = completeParentFd;
    try {
      let admitted = retainedTargetPath
        ? capturePolicyParent(parentFd, parentSpelling)
        : undefined;
      if (!admitted) {
        retainedTargetPath = undefined;
        admitted = await describePosixParent(parentFd, parentSpelling);
      }
      const targetPath = path.join(admitted.parentPath, params.basename);
      await authorizePinnedMutation(params, {
        targetPath,
        mutationPath: targetPath,
        phase: "parent",
      });
      assertPosixParentCurrent(admitted);
      return admitted;
    } catch (error) {
      disposeObservation(parentFd);
      closeFd(parentFd);
      throw error;
    }
  }

  // The canonical preflight spelling has no intentional symlinks in its
  // existing prefix. Walk missing-parent cases one direct child at a time so
  // every existing/opened object is authorized and every mkdir is authorized
  // before dispatch. O_NOFOLLOW makes a concurrently introduced link fail
  // before the next component can be created through it.
  const secureDirectoryFlags = directoryFlags | (fsSync.constants.O_NOFOLLOW ?? 0);
  let currentFd = rootFd;
  let currentOwnedFd: number | undefined;
  let currentPath = params.rootPath;
  let current = retainedTargetPath
    ? capturePolicyParent(rootFd, currentPath)
    : undefined;
  if (!current) {
    retainedTargetPath = undefined;
    current = await describePosixParent(rootFd, currentPath);
  }
  try {
    await authorizePinnedMutation(params, {
      targetPath: retainedTargetPath ?? initialTarget,
      mutationPath: retainedTargetPath ?? initialTarget,
      phase: "parent",
    });
    assertPosixParentCurrent(current);

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const childPath = path.join(currentPath, segment);
      let childFd: number;
      let createdByMkdir = false;
      let createReceipt: PinnedMutationAdmissionReceipt | undefined;
      try {
        childFd = binding.openBeneath(currentFd, segment, secureDirectoryFlags).fd;
      } catch (openError) {
        if (!isNotFoundPathError(openError)) {
          throw normalizePolicyParentOpenError(openError, params);
        }
        const targetPath = retainedTargetPath ?? joinPathSegmentRoute(
          currentPath, segmentRoute, index, params.basename,
        );
        const request = Object.freeze({
          targetPath,
          mutationPath: childPath,
          phase: "parent-create" as const,
        });
        createReceipt = params.mutationAdmission?.tryAuthorizeAtParent?.(
          request,
          current.observation,
        );
        if (!createReceipt) {
          createReceipt = await authorizePinnedMutation(params, request);
          assertPosixParentCurrent(current);
        }
        params.assertBeforeMutation?.();
        // Do not carry pathname freshness across the live authority callback.
        assertPosixParentCurrent(current);
        createdByMkdir = mkdirPolicyChild(binding, currentFd, segment, 0o777);
        try {
          childFd = binding.openBeneath(currentFd, segment, secureDirectoryFlags).fd;
        } catch (createdOpenError) {
          throw normalizePolicyParentOpenError(createdOpenError, params);
        }
      }

      let child: PosixParentAdmission;
      try {
        const acceleratedChild = retainedTargetPath
          ? capturePolicyParent(childFd, childPath)
          : undefined;
        if (acceleratedChild) {
          child = acceleratedChild;
        } else {
          retainedTargetPath = undefined;
          child = await describePosixParent(childFd, childPath);
        }
        if (!sameAbsolutePath(child.parentPath, childPath)) retainedTargetPath = undefined;
        let childAuthorization: PinnedMutationAuthorizationToken | undefined;
        if (createdByMkdir && createReceipt && params.mutationAdmission?.advanceCreatedDirectory) {
          let evidence: PinnedCreatedDirectoryReceipt | undefined;
          try {
            const parent = current.policyDirectory
              ? refreshPolicyStagedDirectoryObservation(current.policyDirectory)
              : checkedMutationDirectory(
                currentPath,
                current.directory.realPath,
                assertStagedDirectoryCurrent(current.directory),
              );
            evidence = Object.freeze({
              admission: createReceipt,
              parent,
              child: child.observation,
            });
          } catch {
            // Leave failed evidence to the full ordered admission below.
          }
          if (evidence) {
            childAuthorization = params.mutationAdmission.advanceCreatedDirectory(evidence);
          }
        }
        const targetPath = retainedTargetPath ?? joinPathSegmentRoute(
          child.parentPath, segmentRoute, index + 1, params.basename,
        );
        const request = Object.freeze({
          targetPath,
          mutationPath: targetPath,
          phase: "parent" as const,
        });
        childAuthorization ??= params.mutationAdmission?.tryAuthorizeAtParent?.(
          request,
          child.observation,
        );
        if (!childAuthorization) {
          await authorizePinnedMutation(params, request);
          assertPosixParentCurrent(child);
        }
      } catch (error) {
        disposeObservation(childFd);
        closeFd(childFd);
        throw error;
      }

      const previousOwnedFd = currentOwnedFd;
      disposeObservation(current.parentFd);
      currentOwnedFd = child.parentFd;
      currentFd = child.parentFd;
      currentPath = child.parentPath;
      current = child;
      if (previousOwnedFd !== undefined) closeFd(previousOwnedFd);
      if (index === segments.length - 1) {
        currentOwnedFd = undefined;
        return child;
      }
    }

    // Empty relative parents are handled by the complete-parent fast path.
    throw new FsSafeError("path-mismatch", "native write parent admission did not complete");
  } finally {
    if (currentOwnedFd !== undefined) {
      disposeObservation(currentOwnedFd);
      closeFd(currentOwnedFd);
    }
  }
}

export async function runPinnedWriteNative(binding: NativeBinding, params: PinnedWriteParams): Promise<FileIdentityStat> {
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
    if (!windows && params.mutationAdmission) {
      const admitted = await capturePolicyAwarePosixParent(
        binding,
        params,
        root.fd,
        directoryFlags,
      );
      parentFd = admitted.parentFd;
      parentPath = admitted.parentPath;
      directory = admitted.directory;
      parentPathStat = admitted.parentPathStat;
    } else if (windows && params.mutationAdmission) {
      const admitted = await capturePolicyAwareWindowsParent(binding, params, rootAdmission);
      parentFd = admitted.fd;
      parentPath = admitted.guard.realPath;
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
    const ownedParent = parentFd;
    parentFd = undefined;
    return await writeNativeStage(
      binding as NativeStagingBinding, ownedParent, closeFd, directory!, params, verificationGuard,
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
