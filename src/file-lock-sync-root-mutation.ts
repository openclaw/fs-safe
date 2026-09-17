import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync } from "./root-context.js";
import {
  directoryComponentNotDirectoryError,
  outsideWorkspaceError,
} from "./root-errors.js";
import {
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
} from "./sidecar-lock-reclaim.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import {
  assertFileLockSyncRootMutationAllowed,
  assertFileLockSyncRootResolvedPathCurrent,
  invokeFileLockSyncRootMutationAuthority,
  type FileLockSyncRootPath,
} from "./file-lock-sync-root.js";
import {
  assertDirectoryCurrent,
  assertRegularFile,
  assertRetainedParentCurrent,
  exactFileIdentity,
  fileReceiptCurrent,
  observeDirectory,
  readFileLockSyncRootSnapshot,
  sameExactIdentity,
  type DirectoryReceipt,
  type FileLockSyncRootDirectoryReceipt,
  type FileLockSyncRootFileReceipt,
} from "./file-lock-sync-root-io.js";
import { pathForWindowsFilesystem } from "./windows-path-alias.js";

function ensureParent(pathAuthority: FileLockSyncRootPath): DirectoryReceipt {
  const authority = pathAuthority.authority;
  const context = authority.context;
  assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
  const targetParent = path.dirname(pathAuthority.path);
  const admitted = admitPathInsideRoot({
    rootPath: context.rootReal,
    candidatePath: targetParent,
    rootIdentity: context.rootIdentity,
  });
  if (!admitted) throw outsideWorkspaceError();
  const relative = admitted.relativePath;
  let current = context.rootReal;
  let currentReceipt = observeDirectory(current);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    assertRootIdentityCurrentSync(context);
    assertDirectoryCurrent(currentReceipt);
    let missing = false;
    try {
      const existing = fs.lstatSync(pathForWindowsFilesystem(next), { bigint: true });
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw directoryComponentNotDirectoryError();
      }
    } catch (error) {
      if (!isNotFoundPathError(error)) throw error;
      missing = true;
    }
    if (missing) {
      assertFileLockSyncRootMutationAllowed(next, authority.denyMutations);
      const mutationAuthorityInvoked = invokeFileLockSyncRootMutationAuthority(authority);
      if (mutationAuthorityInvoked) {
        assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
      }
      assertDirectoryCurrent(currentReceipt);
      assertRootIdentityCurrentSync(context);
      // The callback may retarget a deny-policy alias at this particular
      // intermediate component without changing the admitted final sidecar.
      // Refresh the actual mkdir target after the callback and immediately
      // before mutation.
      if (mutationAuthorityInvoked) {
        assertFileLockSyncRootMutationAllowed(next, authority.denyMutations);
      }
      try {
        fs.mkdirSync(pathForWindowsFilesystem(next));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const nextReceipt = observeDirectory(next);
    assertDirectoryCurrent(currentReceipt);
    assertRootIdentityCurrentSync(context);
    current = nextReceipt.realPath;
    currentReceipt = nextReceipt;
  }
  assertRootIdentityCurrentSync(context);
  assertDirectoryCurrent(currentReceipt);
  return currentReceipt;
}

function fileReceiptCurrentAfterParentCheck(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootFileReceipt,
): boolean {
  try {
    const current = inspectFileIdentitySync(
      () => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }),
      receipt.identity,
    );
    assertRegularFile(current, pathAuthority.authority.hardlinks);
  } catch (error) {
    if (isNotFoundPathError(error) ||
      (error instanceof FsSafeError && error.code === "path-mismatch")) return false;
    throw error;
  }
  // A retained-parent check immediately before this stage supplies the first
  // half of the fence; avoid repeating it before the pathname observation.
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  return true;
}

export function createFileLockSyncRootFile(
  pathAuthority: FileLockSyncRootPath,
  mode: number,
  options: {
    assertBeforeOpen?: () => void;
    onOpenFailure?: (error: unknown) => void;
  } = {},
): { fd: number; receipt: FileLockSyncRootFileReceipt } {
  const parent = ensureParent(pathAuthority);
  if (invokeFileLockSyncRootMutationAuthority(pathAuthority.authority)) {
    assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
    assertRetainedParentCurrent(pathAuthority, parent);
  }
  const noFollow = process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  let fd: number | undefined;
  let receipt: FileLockSyncRootFileReceipt | undefined;
  try {
    options.assertBeforeOpen?.();
    try {
      fd = fs.openSync(
        pathForWindowsFilesystem(pathAuthority.path),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        mode,
      );
    } catch (error) {
      options.onOpenFailure?.(error);
      throw error;
    }
    const opened = inspectFileIdentitySync(() => fs.fstatSync(fd!, { bigint: true }));
    assertRegularFile(opened, pathAuthority.authority.hardlinks);
    receipt = Object.freeze({ identity: exactFileIdentity(opened), parent });
    if (!fileReceiptCurrentAfterParentCheck(pathAuthority, receipt)) {
      throw new FsSafeError("path-mismatch", "created sidecar lock changed before admission");
    }
    return { fd, receipt };
  } catch (error) {
    if (fd === undefined) throw error;
    const failedFd = fd;
    fd = undefined;
    try {
      fs.closeSync(failedFd);
      if (receipt && !removeFileLockSyncRootFile(pathAuthority, receipt)) {
        throw new FsSafeError("path-mismatch", "created sidecar lock changed before cleanup");
      }
    } catch (cleanupError) {
      throw createSuppressedError(error, cleanupError, "file lock create admission and cleanup both failed");
    }
    throw error;
  }
}

export function refreshFileLockSyncRootFileReceipt(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootFileReceipt,
): FileLockSyncRootFileReceipt {
  if (!fileReceiptCurrentAfterParentCheck(pathAuthority, receipt)) {
    throw new FsSafeError("path-mismatch", "created sidecar lock changed before admission");
  }
  return receipt;
}

export function removeFileLockSyncRootFile(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootFileReceipt,
  expected?: SidecarLockSnapshot,
  assertBeforeRemove?: () => boolean | void,
): boolean {
  assertFileLockSyncRootMutationAllowed(pathAuthority.path, pathAuthority.authority.denyMutations);
  const matches = (): boolean => {
    if (!expected) return fileReceiptCurrent(pathAuthority, receipt);
    const current = readFileLockSyncRootSnapshot(pathAuthority, {
      expectedReceipt: receipt,
    });
    const matched = !!current &&
      sameExactIdentity(current.receipt.identity, receipt.identity) &&
      sidecarLockSnapshotMatches(current.snapshot, expected);
    return matched;
  };
  if (!matches()) return false;
  if (invokeFileLockSyncRootMutationAuthority(pathAuthority.authority) && !matches()) return false;
  if (assertBeforeRemove?.() === false) return false;
  assertFileLockSyncRootMutationAllowed(pathAuthority.path, pathAuthority.authority.denyMutations);
  fs.rmSync(pathForWindowsFilesystem(pathAuthority.path));
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  try {
    fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true });
  } catch (error) {
    if (isNotFoundPathError(error)) return true;
    throw error;
  }
  throw new FsSafeError("path-mismatch", "sidecar lock was replaced during removal");
}

export function fileLockSyncRootDirectoryExists(
  pathAuthority: FileLockSyncRootPath,
  pathAlreadyCurrent = false,
): boolean {
  if (!pathAlreadyCurrent) assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
  // A shared path admission may skip only duplicate resolution, never this
  // operation-local Root identity fence before fresh directory inspection.
  assertRootIdentityCurrentSync(pathAuthority.authority.context);
  let stat: BigIntStats;
  try {
    stat = fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
      assertRootIdentityCurrentSync(pathAuthority.authority.context);
      return false;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
  const parent = observeDirectory(path.dirname(pathAuthority.path));
  inspectDirectoryIdentitySync(pathAuthority.path, exactFileIdentity(stat));
  assertDirectoryCurrent(parent);
  assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
  assertRootIdentityCurrentSync(pathAuthority.authority.context);
  return true;
}

export function createFileLockSyncRootDirectory(
  pathAuthority: FileLockSyncRootPath,
): FileLockSyncRootDirectoryReceipt | null {
  const parent = ensureParent(pathAuthority);
  if (invokeFileLockSyncRootMutationAuthority(pathAuthority.authority)) {
    assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
    assertRetainedParentCurrent(pathAuthority, parent);
  }
  try {
    fs.mkdirSync(pathForWindowsFilesystem(pathAuthority.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const stat = inspectDirectoryIdentitySync(pathAuthority.path);
  const receipt = Object.freeze({ identity: exactFileIdentity(stat), parent });
  assertRetainedParentCurrent(pathAuthority, parent);
  inspectDirectoryIdentitySync(pathAuthority.path, receipt.identity);
  return receipt;
}

export function removeFileLockSyncRootDirectory(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootDirectoryReceipt,
): boolean {
  if (!fileLockSyncRootDirectoryReceiptStillCurrent(pathAuthority, receipt)) return false;
  assertFileLockSyncRootMutationAllowed(pathAuthority.path, pathAuthority.authority.denyMutations, true);
  if (invokeFileLockSyncRootMutationAuthority(pathAuthority.authority) &&
    !fileLockSyncRootDirectoryReceiptStillCurrent(pathAuthority, receipt)) return false;
  assertFileLockSyncRootMutationAllowed(pathAuthority.path, pathAuthority.authority.denyMutations, true);
  fs.rmdirSync(pathForWindowsFilesystem(pathAuthority.path));
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  return true;
}

export function fileLockSyncRootDirectoryReceiptStillCurrent(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootDirectoryReceipt,
): boolean {
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  try {
    inspectDirectoryIdentitySync(pathAuthority.path, receipt.identity);
  } catch (error) {
    if (isNotFoundPathError(error) ||
      (error instanceof FsSafeError && error.code === "path-mismatch")) return false;
    throw error;
  }
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  return true;
}
