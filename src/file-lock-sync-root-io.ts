import fs, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrentSync } from "./root-context.js";
import { hardlinkedPathNotAllowedError } from "./root-errors.js";
import type { RootDefaults } from "./root-options.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { realpathSync } from "./realpath.js";
import {
  sidecarLockSnapshotMatches,
} from "./sidecar-lock-reclaim.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import {
  assertFileLockSyncRootResolvedPathCurrent,
  type FileLockSyncRootPath,
} from "./file-lock-sync-root.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";

const MAX_SIDECAR_LOCK_PAYLOAD_BYTES = 1024 * 1024;

export type ExactIdentity = Readonly<{ dev: bigint; ino: bigint }>;

export type DirectoryReceipt = Readonly<{
  identity: ExactIdentity;
  path: string;
  realPath: string;
}>;

export type FileLockSyncRootFileReceipt = Readonly<{
  identity: ExactIdentity;
  parent: DirectoryReceipt;
}>;

export type FileLockSyncRootDirectoryReceipt = Readonly<{
  identity: ExactIdentity;
  parent: DirectoryReceipt;
}>;

export type FileLockSyncRootDiskSnapshot = {
  ownershipToken?: never;
  payload: unknown;
  raw: string;
  stat: Stats;
};

export type FileLockSyncRootSnapshot = Readonly<{
  receipt: FileLockSyncRootFileReceipt;
  snapshot: FileLockSyncRootDiskSnapshot;
}>;

const samePath = (left: string, right: string) =>
  path.relative(path.resolve(left), path.resolve(right)) === "";

export function observeDirectory(pathname: string): DirectoryReceipt {
  const stat = inspectDirectoryIdentitySync(pathname);
  const realPath = realpathSync.native(pathForWindowsFilesystem(pathname));
  assertNoWindowsPathAlias(realPath, "filesystem", "sidecar lock parent uses a Windows filesystem namespace alias");
  if (!samePath(realPath, pathname)) {
    throw new FsSafeError("path-mismatch", "sidecar lock parent changed during operation");
  }
  return Object.freeze({
    identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
    path: pathname,
    realPath,
  });
}

export function assertDirectoryCurrent(receipt: DirectoryReceipt, initial?: BigIntStats): void {
  inspectDirectoryIdentitySync(receipt.path, receipt.identity, initial);
  const currentReal = realpathSync.native(pathForWindowsFilesystem(receipt.path));
  assertNoWindowsPathAlias(currentReal, "filesystem", "sidecar lock parent uses a Windows filesystem namespace alias");
  if (currentReal !== receipt.realPath) {
    throw new FsSafeError("path-mismatch", "sidecar lock parent changed during operation");
  }
}

export function assertRetainedParentCurrent(
  pathAuthority: FileLockSyncRootPath,
  parent: DirectoryReceipt,
): void {
  const context = pathAuthority.authority.context;
  const sharedIdentity = parent.path === context.rootReal &&
    parent.identity.dev === context.rootIdentity.dev && parent.identity.ino === context.rootIdentity.ino;
  let rootStat: BigIntStats | undefined;
  assertRootIdentityCurrentSync(context, sharedIdentity ? stat => { rootStat = stat; } : undefined);
  assertDirectoryCurrent(parent, rootStat);
  assertRootIdentityCurrentSync(context);
}

export function exactFileIdentity(stat: BigIntStats): ExactIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

export function assertRegularFile(
  stat: BigIntStats,
  hardlinks: RootDefaults["hardlinks"],
): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new FsSafeError("not-file", "sidecar lock is not a regular file");
  }
  if (hardlinks !== "allow" && stat.nlink > 1n) throw hardlinkedPathNotAllowedError();
}

export function sameExactIdentity(left: ExactIdentity, right: ExactIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertFreshPathCurrent(pathAuthority: FileLockSyncRootPath): void {
  // The exact Root observation is deliberately last: this helper is used both
  // immediately before fresh pathname I/O and immediately before returning it.
  assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
  assertRootIdentityCurrentSync(pathAuthority.authority.context);
}

function missingAfterCurrentRead(
  pathAuthority: FileLockSyncRootPath,
  expectedReceipt?: FileLockSyncRootFileReceipt,
): null {
  if (expectedReceipt) {
    assertRetainedParentCurrent(pathAuthority, expectedReceipt.parent);
  } else {
    assertFreshPathCurrent(pathAuthority);
  }
  return null;
}

export function readFileLockSyncRootSnapshot(
  pathAuthority: FileLockSyncRootPath,
  options: {
    expectedReceipt?: FileLockSyncRootFileReceipt;
    onOpenFailure?: (error: unknown) => void;
  } = {},
): FileLockSyncRootSnapshot | null {
  const expectedReceipt = options.expectedReceipt;
  if (expectedReceipt) {
    assertRetainedParentCurrent(pathAuthority, expectedReceipt.parent);
  } else {
    assertFreshPathCurrent(pathAuthority);
  }
  let before: BigIntStats;
  try {
    before = inspectFileIdentitySync(
      () => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }),
      expectedReceipt?.identity,
    );
  } catch (error) {
    if (isNotFoundPathError(error) || (
      expectedReceipt && error instanceof FsSafeError && error.code === "path-mismatch"
    )) return missingAfterCurrentRead(pathAuthority, expectedReceipt);
    throw error;
  }
  assertRegularFile(before, pathAuthority.authority.hardlinks);
  const parent = expectedReceipt?.parent ?? observeDirectory(path.dirname(pathAuthority.path));
  let fd: number | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    try {
      fd = fs.openSync(pathForWindowsFilesystem(pathAuthority.path), resolveReadOpenFlags());
    } catch (error) {
      if (isNotFoundPathError(error)) return missingAfterCurrentRead(pathAuthority, expectedReceipt);
      options.onOpenFailure?.(error);
      throw error;
    }
    let opened: BigIntStats;
    try {
      opened = inspectFileIdentitySync(
        () => fs.fstatSync(fd!, { bigint: true }),
        exactFileIdentity(before),
      );
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "path-mismatch") {
        if (expectedReceipt) {
          assertRetainedParentCurrent(pathAuthority, parent);
        } else {
          assertDirectoryCurrent(parent);
          assertFreshPathCurrent(pathAuthority);
        }
        return null;
      }
      throw error;
    }
    assertRegularFile(opened, pathAuthority.authority.hardlinks);
    const raw = readFileDescriptorBoundedSync(fd, MAX_SIDECAR_LOCK_PAYLOAD_BYTES).toString("utf8");
    let after: BigIntStats;
    try {
      after = inspectFileIdentitySync(
        () => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }),
        exactFileIdentity(opened),
      );
    } catch (error) {
      if (isNotFoundPathError(error) ||
        (error instanceof FsSafeError && error.code === "path-mismatch")) {
        if (expectedReceipt) {
          assertRetainedParentCurrent(pathAuthority, parent);
        } else {
          assertDirectoryCurrent(parent);
          assertFreshPathCurrent(pathAuthority);
        }
        return null;
      }
      throw error;
    }
    assertRegularFile(after, pathAuthority.authority.hardlinks);
    const stat = fs.fstatSync(fd);
    if (expectedReceipt) {
      assertRetainedParentCurrent(pathAuthority, parent);
    } else {
      assertDirectoryCurrent(parent);
      assertFreshPathCurrent(pathAuthority);
    }
    const snapshot: FileLockSyncRootDiskSnapshot = {
      raw,
      payload: null,
      stat,
    };
    return Object.freeze({
      receipt: Object.freeze({ identity: exactFileIdentity(opened), parent }),
      snapshot,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        if (operationFailed) {
          throw createSuppressedError(
            closeError,
            operationError,
            "sidecar snapshot admission and descriptor close both failed",
          );
        }
        throw closeError;
      }
    }
  }
}

export function fileLockSyncRootSnapshotStillCurrent(
  pathAuthority: FileLockSyncRootPath,
  observed: FileLockSyncRootSnapshot,
): boolean {
  const current = readFileLockSyncRootSnapshot(pathAuthority, {
    expectedReceipt: observed.receipt,
  });
  return !!current &&
    sameExactIdentity(current.receipt.identity, observed.receipt.identity) &&
    sidecarLockSnapshotMatches(current.snapshot, observed.snapshot);
}

export function fileReceiptCurrent(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootFileReceipt,
): boolean {
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  let current: BigIntStats;
  try {
    current = inspectFileIdentitySync(
      () => fs.lstatSync(pathForWindowsFilesystem(pathAuthority.path), { bigint: true }),
      receipt.identity,
    );
  } catch (error) {
    if (isNotFoundPathError(error) ||
      (error instanceof FsSafeError && error.code === "path-mismatch")) return false;
    throw error;
  }
  assertRegularFile(current, pathAuthority.authority.hardlinks);
  assertRetainedParentCurrent(pathAuthority, receipt.parent);
  return true;
}

export function fileLockSyncRootReceiptStillCurrent(
  pathAuthority: FileLockSyncRootPath,
  receipt: FileLockSyncRootFileReceipt,
): boolean {
  return fileReceiptCurrent(pathAuthority, receipt);
}
