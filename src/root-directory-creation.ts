import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPrivateDirectory } from "./creation-permissions.js";
import {
  assertAsyncDirectoryGuard,
  assertDirectoryIdentitySync,
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { hasNodeErrorCode } from "./path.js";
import {
  checkedMutationDirectory,
  type MutationDirectoryObservation,
} from "./pinned-mutation-observation.js";
import type { PinnedWriteMutationAdmission } from "./pinned-write-types.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { canReuseParentWithMutationAssertion } from "./root-write-lock-binding.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function mutationWalkOptions(
  mutationAdmission: PinnedWriteMutationAdmission,
  operationTarget: (prospectiveDirectory: string) => string,
  assertBeforeMutation: (() => void) | undefined,
  rootPath: string,
  targetPath: string,
) {
  const session = canReuseParentWithMutationAssertion(assertBeforeMutation, rootPath, targetPath)
    ? mutationAdmission.beginSharedParentWalk?.()
    : undefined;
  return {
    dispose: () => session?.dispose(),
    options: {
      rejectSymlinks: mutationAdmission.rejectParentSymlinks,
      revalidateParentAfterBeforeComponent: true,
      retainedTargetPath: session?.retainedTargetPath,
      synchronousAuthorizationIncludesFence: session !== undefined,
      afterCreateComponent: session?.advanceCreatedDirectory,
      beforeCreateComponent: (
        componentPath: string,
        prospectiveDirectory: string,
        retainedTargetPath: string | undefined,
        parent: MutationDirectoryObservation,
      ) => {
        const targetPath = retainedTargetPath ?? operationTarget(prospectiveDirectory);
        const request = Object.freeze({
          targetPath,
          mutationPath: componentPath,
          phase: "parent-create" as const,
        });
        return session?.tryAuthorizeAtParent(request, parent) ??
          (session?.authorize(request) ?? mutationAdmission.authorize(request));
      },
      beforeUseComponent: async (
        _componentPath: string,
        prospectiveDirectory: string,
        retainedTargetPath: string | undefined,
      ) => {
        const targetPath = retainedTargetPath ?? operationTarget(prospectiveDirectory);
        const request = Object.freeze({
          targetPath,
          mutationPath: targetPath,
          phase: "parent" as const,
        });
        await (session?.authorize(request) ?? mutationAdmission.authorize(request));
      },
    },
  };
}

/**
 * Complete the common Root.mkdir case with one exact existing parent. This is
 * optional evidence: every uncertain probe returns to the ordered root walk.
 */
export async function tryMkdirAtExactParent(
  root: RootContext,
  targetPath: string,
  mutationAdmission: PinnedWriteMutationAdmission,
): Promise<boolean> {
  if (getFsSafeTestHooks()?.beforeRootFallbackMutation) return false;
  if (typeof root.rootIdentity.dev !== "bigint" ||
    typeof root.rootIdentity.ino !== "bigint" ||
    root.rootIdentity.dev === 0n || root.rootIdentity.ino === 0n) return false;
  const rootIdentity = Object.freeze({
    dev: root.rootIdentity.dev,
    ino: root.rootIdentity.ino,
  });
  const session = mutationAdmission.beginSharedParentWalk?.();
  if (!session) return false;
  try {
    if (path.resolve(session.retainedTargetPath) !== path.resolve(targetPath)) return false;
    const parentPath = path.dirname(targetPath);
    let parentGuard: AsyncDirectoryGuard<BigIntStats>;
    try {
      parentGuard = await createAsyncDirectoryGuard(parentPath, { bigint: true });
    } catch {
      return false;
    }
    try {
      fsSync.lstatSync(targetPath, { bigint: true });
      return false;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) return false;
    }
    const admittedParent = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: parentPath,
      rootIdentity,
    });
    if (admittedParent?.admission !== "exact" || admittedParent.path !== parentPath ||
      parentGuard.realPath !== parentPath) return false;
    await session.authorize(Object.freeze({
      targetPath,
      mutationPath: targetPath,
      phase: "parent" as const,
    }));
    await assertAsyncDirectoryGuard(parentGuard);
    try {
      fsSync.lstatSync(targetPath, { bigint: true });
      return false;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) return false;
    }
    assertSyncDirectoryGuard(parentGuard);
    const createAdmission = session.tryAuthorizeAtParent(Object.freeze({
      targetPath,
      mutationPath: targetPath,
      phase: "parent-create" as const,
    }), checkedMutationDirectory(parentPath, parentGuard.realPath, parentGuard.stat));
    if (!createAdmission) return false;
    try {
      await fs.mkdir(targetPath);
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) return false;
      throw error;
    }
    const observeCreated = async () => {
      const childGuard = await createAsyncDirectoryGuard(targetPath, { bigint: true });
      const parentAfter = inspectDirectoryIdentitySync(parentPath, parentGuard.stat);
      assertDirectoryIdentitySync(root.rootReal, rootIdentity);
      const admittedChild = admitPathInsideRoot({
        rootPath: root.rootReal,
        candidatePath: childGuard.realPath,
        rootIdentity,
      });
      if (childGuard.realPath !== targetPath || childGuard.dir !== targetPath ||
        admittedChild?.admission !== "exact" || admittedChild.path !== targetPath) {
        throw new FsSafeError("path-mismatch", "created directory changed during operation");
      }
      return { childGuard, parentAfter };
    };
    try {
      const created = await observeCreated();
      if (session.advanceCreatedDirectory(Object.freeze({
        admission: createAdmission,
        parent: checkedMutationDirectory(parentPath, parentGuard.realPath, created.parentAfter),
        child: checkedMutationDirectory(targetPath, created.childGuard.realPath, created.childGuard.stat),
      }))) return true;
    } catch {
      // Post-create observations are optional receipt evidence. The directory
      // was already created, so renew ordered admission without a second mkdir.
    }
    await session.authorize(Object.freeze({
      targetPath,
      mutationPath: targetPath,
      phase: "parent" as const,
    }));
    await assertAsyncDirectoryGuard(parentGuard);
    assertDirectoryIdentitySync(root.rootReal, rootIdentity);
    assertFinalSymlinkRejected(targetPath, true);
    const refreshed = await observeCreated();
    await assertAsyncDirectoryGuard(parentGuard);
    await assertAsyncDirectoryGuard(refreshed.childGuard);
    assertDirectoryIdentitySync(root.rootReal, rootIdentity);
    return true;
  } finally {
    session.dispose();
  }
}

export async function prepareRootWriteTarget(
  root: RootContext,
  targetPath: string,
  assertBeforeMutation?: () => void,
  mutationAdmission?: PinnedWriteMutationAdmission,
  privateMode = false,
): Promise<string> {
  const basename = path.basename(targetPath);
  const baseParams = {
    rootReal: root.rootReal,
    rootIdentity: root.rootIdentity,
    targetPath: path.dirname(targetPath),
    assertBeforeMutation,
    private: privateMode,
    mode: privateMode ? 0o700 : undefined,
  };
  const mutationWalk = mutationAdmission
    ? mutationWalkOptions(
      mutationAdmission,
      (prospectiveParent) => path.join(prospectiveParent, basename),
      assertBeforeMutation,
      root.rootReal,
      targetPath,
    )
    : undefined;
  let parentPath: string;
  try {
    parentPath = await mkdirPathComponentsWithGuards(mutationWalk ? {
      ...baseParams,
      ...mutationWalk.options,
    } : baseParams);
  } finally {
    mutationWalk?.dispose();
  }
  // Continue through the guarded walk's real parent instead of re-entering
  // the original path through a symlinked component.
  return path.join(parentPath, basename);
}

export async function mkdirPathFallback(
  root: RootContext,
  resolved: { rootReal: string; resolved: string },
  assertBeforeMutation?: () => void,
  rejectSymlinks = false,
  mutationAdmission?: PinnedWriteMutationAdmission,
  privateMode = false,
): Promise<void> {
  const baseParams = {
    rootReal: resolved.rootReal, targetPath: resolved.resolved, assertBeforeMutation,
    rootIdentity: root.rootIdentity,
    rejectSymlinks,
    private: privateMode,
    mode: privateMode ? 0o700 : undefined,
    beforeComponent: async (componentPath: string) => await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath),
  };
  const mutationWalk = mutationAdmission
    ? mutationWalkOptions(
      mutationAdmission,
      (prospectiveDirectory) => prospectiveDirectory,
      assertBeforeMutation,
      root.rootReal,
      resolved.resolved,
    )
    : undefined;
  try {
    const directory = await mkdirPathComponentsWithGuards(mutationWalk ? {
      ...baseParams,
      ...mutationWalk.options,
      rejectSymlinks: rejectSymlinks || mutationAdmission!.rejectParentSymlinks,
    } : baseParams);
    if (privateMode) {
      const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
      await assertPrivateDirectory(directory);
      await assertAsyncDirectoryGuard(guard);
      await assertRootIdentityCurrent(root);
    }
  } finally {
    mutationWalk?.dispose();
  }
}
