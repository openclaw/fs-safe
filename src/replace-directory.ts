import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import {
  classifyNativeRenameFailure,
  NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH,
} from "./native-rename-outcome.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { RetainedDirectoryReplacement } from "./retained-directory-replacement.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { admitStandalonePublicationPath } from "./standalone-publication-path.js";
import { serializePathWrite } from "./write-queue.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type ReplaceDirectoryAtomicOptions = {
  stagedDir: string;
  targetDir: string;
  backupPrefix?: string;
};

type ExactDirectoryGuard = AsyncDirectoryGuard<BigIntStats>;

function distinctGuards(
  source: ExactDirectoryGuard,
  target: ExactDirectoryGuard,
): readonly ExactDirectoryGuard[] {
  return source === target ? [source] : [source, target];
}

function assertGuardsCurrent(guards: readonly ExactDirectoryGuard[]): void {
  for (const guard of guards) assertSyncDirectoryGuard(guard);
}

type DirectoryReplacementDetails = Readonly<{
  phase: "backup" | "publish" | "rollback" | "cleanup";
  publication: "not-published" | "published" | "indeterminate";
  recovery: "restored" | "restored-unverified" | "backup-path-preserved" |
    "cleanup-incomplete" | "indeterminate" | "none";
  backupPath?: string;
}>;

type RenameTransition = "not-renamed" | "renamed" | "indeterminate";

function copyOperationalCode(target: Error, source: unknown): void {
  const code = (source as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    Object.defineProperty(target, "code", { configurable: true, value: code });
  }
}

function replacementFailure(
  error: unknown,
  message: string,
  details: DirectoryReplacementDetails,
): Error {
  if (error instanceof FsSafeError) {
    return new FsSafeError(error.code, message, { cause: error, details });
  }
  const failure = new Error(message, { cause: error });
  copyOperationalCode(failure, error);
  Object.defineProperty(failure, "details", { configurable: true, value: details });
  return failure;
}

function replacementAggregate(
  error: unknown,
  recoveryError: unknown,
  message: string,
  details: DirectoryReplacementDetails,
): Error {
  const combined = new AggregateError(
    [error, recoveryError],
    "directory replacement operation and recovery both failed",
  );
  if (error instanceof FsSafeError) {
    return new FsSafeError(error.code, message, { cause: combined, details });
  }
  const failure = new Error(message, { cause: combined });
  copyOperationalCode(failure, error);
  Object.defineProperty(failure, "details", { configurable: true, value: details });
  return failure;
}

function isMissingDirectoryEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function observeOptionalDirectory(pathname: string): BigIntStats | undefined {
  let initial: BigIntStats;
  try {
    initial = fsSync.lstatSync(pathname, { bigint: true });
  } catch (error) {
    if (isMissingDirectoryEntry(error)) return undefined;
    throw error;
  }
  return inspectDirectoryIdentitySync(pathname, undefined, initial);
}

function normalizeNativeRenameFailure(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH) {
    return new FsSafeError(
      "path-mismatch",
      "directory replacement source identity changed before native rename",
      { cause: error },
    );
  }
  if (code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP" ||
    code === "EOPNOTSUPP") {
    return new FsSafeError(
      "helper-unavailable",
      "native no-replace directory rename is unavailable on this filesystem",
      { cause: error },
    );
  }
  return error;
}

function renameRetainedDirectory(params: {
  from: string;
  to: string;
  sourceParent: ExactDirectoryGuard;
  targetParent: ExactDirectoryGuard;
  expectedSource: Pick<BigIntStats, "dev" | "ino">;
  renameNoReplace(expectedSource: Pick<BigIntStats, "dev" | "ino">): void;
  onIndeterminate(): void;
  onRenamed?(identity: BigIntStats): void;
}): BigIntStats {
  const guards = distinctGuards(params.sourceParent, params.targetParent);
  assertGuardsCurrent(guards);
  const initial = fsSync.lstatSync(params.from, { bigint: true });
  const identity = inspectDirectoryIdentitySync(
    params.from,
    params.expectedSource,
    initial,
  );
  try {
    params.renameNoReplace(identity);
  } catch (error) {
    if (classifyNativeRenameFailure(error) === "indeterminate") {
      params.onIndeterminate();
    }
    throw normalizeNativeRenameFailure(error);
  }
  // Record the transition synchronously before any post-rename observation.
  params.onRenamed?.(identity);
  inspectDirectoryIdentitySync(params.to, identity);
  assertGuardsCurrent(guards);
  return identity;
}

export async function replaceDirectoryAtomic(
  options: ReplaceDirectoryAtomicOptions,
): Promise<void> {
  const stagedDirInput = admitStandalonePublicationPath(
    options.stagedDir,
    "staged directory uses a Windows filesystem namespace alias",
  );
  const targetDirInput = admitStandalonePublicationPath(
    options.targetDir,
    "target directory uses a Windows filesystem namespace alias",
  );
  const stagedDir = path.resolve(stagedDirInput);
  const targetDir = path.resolve(targetDirInput);
  assertNoWindowsPathAlias(stagedDir, "filesystem", "staged directory uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(targetDir, "filesystem", "target directory uses a Windows filesystem namespace alias");
  const backupPrefixInput = options.backupPrefix;
  await serializePathWrite(targetDir, async () => {
    await replaceDirectoryAtomicUnserialized(stagedDir, targetDir, backupPrefixInput);
  });
}

async function replaceDirectoryAtomicUnserialized(
  stagedDir: string,
  targetDir: string,
  backupPrefixInput: string | undefined,
): Promise<void> {
  const parentDir = path.dirname(targetDir);
  const backupPrefix = assertSafePathPrefix(
    backupPrefixInput ?? ".fs-safe-dir-backup-",
    { label: "atomic directory backup prefix" },
  );
  const backupDir = path.join(
    parentDir,
    `${backupPrefix}${process.pid}-${randomUUID()}`,
  );
  const backup: { identity: BigIntStats | undefined; transition: RenameTransition } = {
    identity: undefined,
    transition: "not-renamed",
  };
  const publication: { status: DirectoryReplacementDetails["publication"] } = {
    status: "not-published",
  };
  let operationFailed = false;
  let operationError: unknown;
  let operationDetails: DirectoryReplacementDetails = {
    phase: "backup",
    publication: publication.status,
    recovery: "none",
  };

  const retainedBinding = RetainedDirectoryReplacement.requireBinding();
  await fs.mkdir(recursiveMkdirPath(parentDir), { recursive: true });
  const targetParent = await createAsyncDirectoryGuard(parentDir, { bigint: true });
  const stagedParentDir = path.dirname(stagedDir);
  const stagedParent = stagedParentDir === parentDir
    ? targetParent
    : await createAsyncDirectoryGuard(stagedParentDir, { bigint: true });
  const stagedIdentity = inspectDirectoryIdentitySync(stagedDir);
  const targetIdentity = observeOptionalDirectory(targetDir);
  const retained = RetainedDirectoryReplacement.retain({
    targetParent: {
      path: parentDir,
      realPath: targetParent.realPath,
      identity: targetParent.stat,
    },
    stagedParent: {
      path: stagedParentDir,
      realPath: stagedParent.realPath,
      identity: stagedParent.stat,
    },
    ...(targetIdentity ? {
      originalTarget: { path: targetDir, identity: targetIdentity },
    } : {}),
  }, retainedBinding);
  const targetBasename = path.basename(targetDir);
  const stagedBasename = path.basename(stagedDir);
  const backupBasename = path.basename(backupDir);

  const details = (
    phase: DirectoryReplacementDetails["phase"],
    recovery: DirectoryReplacementDetails["recovery"],
  ): DirectoryReplacementDetails => {
    operationDetails = {
      phase,
      publication: publication.status,
      recovery,
      ...(backup.transition === "not-renamed" ? {} : { backupPath: backupDir }),
    };
    return operationDetails;
  };

  const rollback = (
    error: unknown,
    failedPhase: "backup" | "publish",
    identity: BigIntStats,
  ): never => {
    const rollbackState: { transition: RenameTransition } = {
      transition: "not-renamed",
    };
    try {
      renameRetainedDirectory({
        from: backupDir,
        to: targetDir,
        sourceParent: targetParent,
        targetParent,
        expectedSource: identity,
        renameNoReplace: expectedSource => {
          retained.renameNoReplace("target", backupBasename, targetBasename, expectedSource);
        },
        onIndeterminate() {
          rollbackState.transition = "indeterminate";
          backup.transition = "indeterminate";
        },
        onRenamed() {
          rollbackState.transition = "renamed";
          backup.transition = "not-renamed";
        },
      });
    } catch (rollbackError) {
      const recovery = rollbackState.transition === "renamed"
        ? "restored-unverified"
        : rollbackState.transition === "indeterminate"
          ? "indeterminate"
          : "backup-path-preserved";
      throw replacementAggregate(
        error,
        rollbackError,
        `directory ${failedPhase} and rollback failed`,
        details("rollback", recovery),
      );
    }
    throw replacementFailure(
      error,
      `directory ${failedPhase} failed after restoring the original target`,
      details(failedPhase, "restored"),
    );
  };

  try {
    if (targetIdentity) {
      try {
        backup.identity = renameRetainedDirectory({
          from: targetDir,
          to: backupDir,
          sourceParent: targetParent,
          targetParent,
          expectedSource: targetIdentity,
          renameNoReplace: expectedSource => {
            retained.renameNoReplace("target", targetBasename, backupBasename, expectedSource);
          },
          onIndeterminate() {
            backup.transition = "indeterminate";
          },
          onRenamed(identity) {
            backup.identity = identity;
            backup.transition = "renamed";
          },
        });
      } catch (err) {
        if (backup.transition === "renamed" && backup.identity) {
          rollback(err, "backup", backup.identity);
        }
        const recovery = backup.transition === "indeterminate" ? "indeterminate" : "none";
        throw replacementFailure(
          err,
          "directory backup failed before publication",
          details("backup", recovery),
        );
      }
    }

    try {
      renameRetainedDirectory({
        from: stagedDir,
        to: targetDir,
        sourceParent: stagedParent,
        targetParent,
        expectedSource: stagedIdentity,
        renameNoReplace: expectedSource => {
          retained.renameNoReplace("staged", stagedBasename, targetBasename, expectedSource);
        },
        onIndeterminate() {
          publication.status = "indeterminate";
        },
        onRenamed() {
          publication.status = "published";
        },
      });
    } catch (err) {
      if (publication.status === "published") {
        throw replacementFailure(
          err,
          "published directory failed retained identity verification",
          details("publish", backup.transition === "renamed" ? "backup-path-preserved" : "none"),
        );
      }
      if (publication.status === "indeterminate") {
        throw replacementFailure(
          err,
          "directory publication outcome is indeterminate",
          details("publish", backup.transition === "renamed" ? "backup-path-preserved" : "none"),
        );
      }
      if (backup.transition === "renamed" && backup.identity) {
        rollback(err, "publish", backup.identity);
      }
      throw replacementFailure(
        err,
        "directory publication failed before commit",
        details("publish", "none"),
      );
    }

    details("publish", backup.transition === "renamed" ? "backup-path-preserved" : "none");

    if (backup.transition === "renamed" && backup.identity) {
      let cleanupAttempted = false;
      try {
        assertSyncDirectoryGuard(targetParent);
        inspectDirectoryIdentitySync(backupDir, backup.identity);
        cleanupAttempted = true;
        const outcome = await retained.removeOriginal(backupBasename);
        if (outcome !== "removed") {
          throw new FsSafeError("path-mismatch", "retained backup changed before bounded cleanup");
        }
        backup.transition = "not-renamed";
        details("cleanup", "none");
      } catch (error) {
        throw replacementFailure(error, "published directory but retained backup cleanup failed", {
          ...details(
            "cleanup",
            cleanupAttempted ? "cleanup-incomplete" : "backup-path-preserved",
          ),
        });
      }
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      retained.close();
    } catch (closeError) {
      if (operationFailed) {
        throw replacementAggregate(
          operationError,
          closeError,
          "directory replacement and retained descriptor close failed",
          operationDetails,
        );
      }
      throw replacementFailure(
        closeError,
        "directory replacement retained descriptor close failed",
        operationDetails,
      );
    }
  }
}
