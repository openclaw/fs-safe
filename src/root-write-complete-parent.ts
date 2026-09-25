import fsSync from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  createAsyncDirectoryGuard,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { admitPathInsideRoot, sameNormalizedPathSpelling } from "./root-boundary.js";
import { ordinaryWindowsSegments } from "./pinned-mutation-shared-route.js";
import type { RootContext } from "./root-context.js";
import { prepareRootWriteTarget } from "./root-directory-creation.js";
import { errorCauseOptions } from "./root-errors.js";
import type { GuardedRootWriteTarget } from "./root-write-admission.js";
import { canReuseParentWithMutationAssertion } from "./root-write-lock-binding.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

/**
 * Exact, operation-local evidence that an ordinary shared-JavaScript write
 * already has a complete parent. Path selection consumes this instead of
 * recapturing the same parent after a component walk.
 */
export type PreparedRootWriteParent = Readonly<{
  targetPath: string;
  parentGuard: AsyncDirectoryGuard<BigIntStats>;
  rootPath: string;
  rootIdentity: Readonly<{ dev: bigint; ino: bigint }>;
  nativeMode: string;
  target: BigIntStats | null;
}>;

type SharedRootWriteTargetParams = Readonly<{
  relativePath: string;
  guardedTarget: GuardedRootWriteTarget;
  mkdir?: boolean;
  assertBeforeMutation?: () => void;
}>;

export type SharedRootWriteTarget = Readonly<{
  targetPath: string;
  mutationAdmission: GuardedRootWriteTarget["mutationAdmission"];
  preparedParent?: PreparedRootWriteParent;
}>;

export function writeSelectionChanged(cause?: unknown): FsSafeError {
  return new FsSafeError("path-mismatch", "write target changed during operation", errorCauseOptions(cause));
}

function ordinarySharedWriteRoute(
  root: RootContext,
  relativePath: string,
  operationTargetPath: string,
): boolean {
  if (process.versions.bun || relativePath === "" || relativePath.startsWith("~") ||
    relativePath.includes("\0") || path.isAbsolute(relativePath)) return false;
  if (process.platform === "win32") {
    if (!ordinaryWindowsSegments(relativePath)) return false;
  } else if (relativePath.includes("\\") || relativePath.split("/").some(
    segment => segment === "" || segment === "." || segment === "..",
  )) return false;
  const routed = path.resolve(root.rootReal, relativePath);
  const admitted = admitPathInsideRoot({
    rootPath: root.rootReal,
    candidatePath: routed,
    rootIdentity: root.rootIdentity,
  });
  return admitted?.admission === "exact" &&
    sameNormalizedPathSpelling(admitted.path, routed) &&
    sameNormalizedPathSpelling(routed, operationTargetPath);
}

// Preparation is optional evidence. An exact identity mismatch is conclusive
// and remains fail-closed; every other probe failure must let the established
// ordered component admission classify the same filesystem state.
function deoptPreparationFailure(error: unknown): undefined {
  if (error instanceof FsSafeError && error.code === "path-mismatch") throw error;
  return undefined;
}

function capturePreparedTargetObservation(
  targetPath: string,
): BigIntStats | null | undefined {
  let stat: BigIntStats;
  try {
    stat = inspectFileIdentitySync(() => fsSync.lstatSync(targetPath, { bigint: true }));
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return null;
    return deoptPreparationFailure(error);
  }
  // Final aliases retain the established full component walk and selected-path
  // admission. The shortcut is intentionally limited to an ordinary spelling.
  if (stat.isSymbolicLink()) return undefined;
  let realPath: string;
  try {
    realPath = realpathSync.native(targetPath);
  } catch (error) {
    return deoptPreparationFailure(error);
  }
  if (!sameNormalizedPathSpelling(realPath, targetPath)) return undefined;
  return stat;
}

function samePreparedTargetFacts(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink;
}

function assertPreparedTargetCurrent(prepared: PreparedRootWriteParent): void {
  if (prepared.target === null) {
    try {
      fsSync.lstatSync(prepared.targetPath, { bigint: true });
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) return;
      throw writeSelectionChanged(error);
    }
    throw writeSelectionChanged();
  }
  try {
    const current = inspectFileIdentitySync(
      () => fsSync.lstatSync(prepared.targetPath, { bigint: true }),
      prepared.target,
    );
    if (current.isSymbolicLink() || !samePreparedTargetFacts(prepared.target, current)) {
      throw writeSelectionChanged();
    }
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch") throw error;
    throw writeSelectionChanged(error);
  }
}

export function assertPreparedRootWriteParentCurrent(
  prepared: PreparedRootWriteParent,
  verifyTarget = false,
): void {
  try {
    if (getFsSafeNativeConfig().mode !== prepared.nativeMode) throw writeSelectionChanged();
    if (!sameNormalizedPathSpelling(prepared.parentGuard.dir, prepared.rootPath)) {
      assertDirectoryIdentitySync(prepared.rootPath, prepared.rootIdentity);
    } else if (prepared.parentGuard.stat.dev !== prepared.rootIdentity.dev ||
      prepared.parentGuard.stat.ino !== prepared.rootIdentity.ino) {
      throw writeSelectionChanged();
    }
    const parent = inspectDirectoryIdentitySync(prepared.parentGuard.dir, prepared.parentGuard.stat);
    if (parent.mode !== prepared.parentGuard.stat.mode ||
      parent.nlink !== prepared.parentGuard.stat.nlink ||
      !sameNormalizedPathSpelling(
        realpathSync.native(prepared.parentGuard.dir),
        prepared.parentGuard.realPath,
      )) throw writeSelectionChanged();
    if (verifyTarget) assertPreparedTargetCurrent(prepared);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch") throw error;
    throw writeSelectionChanged(error);
  }
}

async function prepareCompleteRootWriteParent(
  root: RootContext,
  guarded: GuardedRootWriteTarget,
  relativePath: string,
): Promise<PreparedRootWriteParent | undefined> {
  if (!guarded.mutationAdmission || !guarded.selectedTargetAdmission ||
    typeof root.rootIdentity.dev !== "bigint" || typeof root.rootIdentity.ino !== "bigint" ||
    !ordinarySharedWriteRoute(root, relativePath, guarded.targetPath) ||
    !sameNormalizedPathSpelling(guarded.resolvedPath.resolved, guarded.targetPath)) return undefined;
  const parentPath = path.dirname(guarded.targetPath);
  const admittedParent = admitPathInsideRoot({
    rootPath: root.rootReal,
    candidatePath: parentPath,
    rootIdentity: root.rootIdentity,
  });
  if (admittedParent?.admission !== "exact" ||
    !sameNormalizedPathSpelling(admittedParent.path, parentPath)) return undefined;
  let parentGuard: AsyncDirectoryGuard<BigIntStats>;
  try {
    parentGuard = await createAsyncDirectoryGuard(parentPath, { bigint: true });
  } catch (error) {
    return deoptPreparationFailure(error);
  }
  if (!sameNormalizedPathSpelling(parentGuard.dir, parentPath) ||
    !sameNormalizedPathSpelling(parentGuard.realPath, parentPath)) return undefined;
  const target = capturePreparedTargetObservation(guarded.targetPath);
  if (target === undefined) return undefined;
  return Object.freeze({
    targetPath: guarded.targetPath,
    parentGuard,
    rootPath: root.rootReal,
    rootIdentity: Object.freeze({ dev: root.rootIdentity.dev, ino: root.rootIdentity.ino }),
    nativeMode: getFsSafeNativeConfig().mode,
    target,
  });
}

export async function prepareSharedRootWriteTarget(
  root: RootContext,
  params: SharedRootWriteTargetParams,
): Promise<SharedRootWriteTarget> {
  const { guardedTarget } = params;
  const resolvedPath = guardedTarget.resolvedPath.resolved;
  const mutationAdmission = guardedTarget.mutationAdmission;
  const beforeParentAdmission = mutationAdmission
    ? getFsSafeTestHooks()?.beforePinnedWriteParentAdmission
    : undefined;
  if (mutationAdmission) await beforeParentAdmission?.(resolvedPath);
  const preparedParent = params.mkdir !== false &&
    canReuseParentWithMutationAssertion(params.assertBeforeMutation, root.rootReal, guardedTarget.targetPath) &&
    beforeParentAdmission === undefined
    ? await prepareCompleteRootWriteParent(root, guardedTarget, params.relativePath)
    : undefined;
  const targetPath = params.mkdir === false
    ? guardedTarget.targetPath
    : preparedParent?.targetPath ?? await prepareRootWriteTarget(
      root,
      resolvedPath,
      params.assertBeforeMutation,
      mutationAdmission,
    );
  return { targetPath, mutationAdmission, preparedParent };
}
