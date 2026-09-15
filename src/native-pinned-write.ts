import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDirectoryIdentity } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows, sameNativeIdentity } from "./native-pinned-write-windows.js";
import { assertNativeStaging, writeNativeStage, type NativeStagingBinding } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import type {
  PinnedCreatedDirectoryReceipt,
  PinnedMutationAdmissionReceipt,
  PinnedWriteParams,
} from "./pinned-write.js";
import {
  assertStagedDirectoryCurrent,
  describeStagedDirectory,
  exactIdentityMatches,
} from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { realpathSync } from "./realpath.js";
import { isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import { checkedMutationDirectory } from "./pinned-mutation-observation.js";
import { createPathSegmentRoute, joinPathSegmentRoute, type PathSegmentRoute } from "./path-segment-route.js";

type PosixParentAdmission = {
  parentFd: number;
  parentPath: string;
  directory: ReturnType<typeof describeStagedDirectory>;
  parentPathStat: BigIntStats;
};

function relativeParentSegments(relativeParentPath: string): string[] {
  return relativeParentPath.split("/").filter(Boolean);
}

function prospectiveTargetPath(
  parentPath: string,
  parentRoute: PathSegmentRoute,
  offset: number,
  basename: string,
): string {
  return joinPathSegmentRoute(parentPath, parentRoute, offset, basename);
}

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
  request: {
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  },
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
  return { parentFd, parentPath, directory, parentPathStat };
}

async function capturePolicyAwarePosixParent(
  binding: NativeBinding,
  params: PinnedWriteParams,
  rootFd: number,
  directoryFlags: number,
): Promise<PosixParentAdmission> {
  const segments = relativeParentSegments(params.relativeParentPath);
  const parentSpelling = segments.length
    ? path.join(params.rootPath, ...segments)
    : params.rootPath;

  // Preserve the one-open hot path when the complete parent still exists.
  // Policy is attached only after the opened descriptor is associated with its
  // current canonical pathname, so a contained redirect cannot retain the old
  // preflight authorization.
  try {
    const parentFd = binding.openBeneath(rootFd, params.relativeParentPath, directoryFlags).fd;
    try {
      const admitted = await describePosixParent(parentFd, parentSpelling);
      const targetPath = path.join(admitted.parentPath, params.basename);
      await authorizePinnedMutation(params, {
        targetPath,
        mutationPath: targetPath,
        phase: "parent",
      });
      assertStagedDirectoryCurrent(admitted.directory);
      return admitted;
    } catch (error) {
      fsSync.closeSync(parentFd);
      throw error;
    }
  } catch (error) {
    if (!isNotFoundPathError(error) || !params.mkdir) throw error;
  }

  const segmentRoute = createPathSegmentRoute(segments);
  // The canonical preflight spelling has no intentional symlinks in its
  // existing prefix. Walk missing-parent cases one direct child at a time so
  // every existing/opened object is authorized and every mkdir is authorized
  // before dispatch. O_NOFOLLOW makes a concurrently introduced link fail
  // before the next component can be created through it.
  const secureDirectoryFlags = directoryFlags | (fsSync.constants.O_NOFOLLOW ?? 0);
  let currentFd = rootFd;
  let currentOwnedFd: number | undefined;
  let currentPath = params.rootPath;
  let currentDirectory = describeStagedDirectory(rootFd, currentPath);
  try {
    let retainedTargetPath = params.mutationAdmission?.beginParentWalk?.();
    const initialTarget = prospectiveTargetPath(currentPath, segmentRoute, 0, params.basename);
    if (retainedTargetPath && !sameAbsolutePath(retainedTargetPath, initialTarget)) {
      retainedTargetPath = undefined;
    }
    await authorizePinnedMutation(params, {
      targetPath: retainedTargetPath ?? initialTarget,
      mutationPath: retainedTargetPath ?? initialTarget,
      phase: "parent",
    });

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
        const targetPath = retainedTargetPath ?? prospectiveTargetPath(
          currentPath, segmentRoute, index, params.basename,
        );
        createReceipt = await authorizePinnedMutation(params, {
          targetPath,
          mutationPath: childPath,
          phase: "parent-create",
        });
        assertStagedDirectoryCurrent(currentDirectory);
        params.assertBeforeMutation?.();
        createdByMkdir = mkdirPolicyChild(binding, currentFd, segment, 0o777);
        try {
          childFd = binding.openBeneath(currentFd, segment, secureDirectoryFlags).fd;
        } catch (createdOpenError) {
          throw normalizePolicyParentOpenError(createdOpenError, params);
        }
      }

      let child: PosixParentAdmission;
      try {
        child = await describePosixParent(childFd, childPath);
        if (!sameAbsolutePath(child.parentPath, childPath)) retainedTargetPath = undefined;
        if (createdByMkdir && createReceipt && params.mutationAdmission?.advanceCreatedDirectory) {
          let evidence: PinnedCreatedDirectoryReceipt | undefined;
          try {
            const parentStat = assertStagedDirectoryCurrent(currentDirectory);
            const childStat = assertStagedDirectoryCurrent(child.directory);
            evidence = Object.freeze({
              admission: createReceipt,
              parent: checkedMutationDirectory(currentPath, currentDirectory.realPath, parentStat),
              child: checkedMutationDirectory(childPath, child.directory.realPath, childStat),
            });
          } catch {
            // Leave failed evidence to the full ordered admission below.
          }
          if (evidence) {
            params.mutationAdmission.advanceCreatedDirectory(evidence);
          }
        }
        const targetPath = retainedTargetPath ?? prospectiveTargetPath(
          child.parentPath, segmentRoute, index + 1, params.basename,
        );
        await authorizePinnedMutation(params, {
          targetPath,
          mutationPath: targetPath,
          phase: "parent",
        });
        assertStagedDirectoryCurrent(child.directory);
      } catch (error) {
        fsSync.closeSync(childFd);
        throw error;
      }

      const previousOwnedFd = currentOwnedFd;
      currentOwnedFd = child.parentFd;
      currentFd = child.parentFd;
      currentPath = child.parentPath;
      currentDirectory = child.directory;
      if (previousOwnedFd !== undefined) fsSync.closeSync(previousOwnedFd);
      if (index === segments.length - 1) {
        currentOwnedFd = undefined;
        return child;
      }
    }

    // Empty relative parents are handled by the complete-parent fast path.
    throw new FsSafeError("path-mismatch", "native write parent admission did not complete");
  } finally {
    if (currentOwnedFd !== undefined) fsSync.closeSync(currentOwnedFd);
  }
}

export async function runPinnedWriteNative(binding: NativeBinding, params: PinnedWriteParams): Promise<FileIdentityStat> {
  const windows = process.platform === "win32";
  if (!windows) {
    assertNativeStaging(binding);
  }
  const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
  const root = await fs.open(params.rootPath, directoryFlags);
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
    const exactRoot = typeof params.rootIdentity?.dev === "bigint" && typeof params.rootIdentity.ino === "bigint"
      ? { dev: params.rootIdentity.dev, ino: params.rootIdentity.ino } : undefined;
    let rootMatches: boolean;
    if (exactRoot) {
      inspectFileIdentitySync(() => fsSync.fstatSync(root.fd, { bigint: true }), exactRoot);
      rootMatches = true;
    } else if (windows) {
      const identity = binding.fstatIdentity(root.fd);
      rootMatches = !params.rootIdentity || sameNativeIdentity(params.rootIdentity, identity);
    } else {
      const identity = fsSync.fstatSync(root.fd, { bigint: true });
      rootMatches = !params.rootIdentity || exactIdentityMatches(params.rootIdentity, identity);
    }
    if (!rootMatches) {
      throw new FsSafeError("path-mismatch", "root path changed during native write");
    }
    let parentPath: string;
    let directory: ReturnType<typeof describeStagedDirectory> | undefined;
    let parentPathStat: Stats | BigIntStats;
    let policyParentAdmitted = false;
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
      policyParentAdmitted = true;
    } else {
      if (params.mkdir) {
        params.assertBeforeMutation?.();
        binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
      }
      parentFd = binding.openBeneath(
        root.fd,
        params.relativeParentPath,
        directoryFlags,
      ).fd;
      parentPath = realpathSync.native(
        params.relativeParentPath
          ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
          : params.rootPath,
      );
      directory = windows ? undefined : describeStagedDirectory(parentFd, parentPath);
      parentPathStat = exactRoot
        ? await inspectDirectoryIdentity(parentPath, inspectFileIdentitySync(() => fsSync.fstatSync(parentFd!, { bigint: true })))
        : fsSync.lstatSync(parentPath);
    }
    if (windows && !exactRoot) {
      const parentIdentity = binding.fstatIdentity(parentFd);
      if (parentPathStat.isSymbolicLink() || !sameNativeIdentity(parentPathStat, parentIdentity)) {
        throw new FsSafeError("path-mismatch", "native write parent changed during resolution");
      }
    } else if (!windows && (parentPathStat.isSymbolicLink() || !exactIdentityMatches(parentPathStat, directory!.identity))) {
      throw new FsSafeError("path-mismatch", "native write parent changed during resolution");
    }
    if (!policyParentAdmitted && params.mutationAdmission) {
      const targetPath = path.join(parentPath, params.basename);
      await authorizePinnedMutation(params, {
        targetPath,
        mutationPath: targetPath,
        phase: "parent",
      });
      await inspectDirectoryIdentity(
        parentPath,
        inspectFileIdentitySync(() => fsSync.fstatSync(parentFd!, { bigint: true })),
      );
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
      binding as NativeStagingBinding, ownedParent, directory!, params, verificationGuard,
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
