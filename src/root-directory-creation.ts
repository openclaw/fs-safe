import path from "node:path";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import type { MutationDirectoryObservation } from "./pinned-mutation-observation.js";
import type { PinnedWriteMutationAdmission } from "./pinned-write.js";
import type { RootContext } from "./root-context.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function mutationWalkOptions(
  mutationAdmission: PinnedWriteMutationAdmission,
  operationTarget: (prospectiveDirectory: string) => string,
  assertBeforeMutation: (() => void) | undefined,
) {
  const session = assertBeforeMutation === undefined
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

export async function prepareRootWriteTarget(
  root: RootContext,
  targetPath: string,
  assertBeforeMutation?: () => void,
  mutationAdmission?: PinnedWriteMutationAdmission,
): Promise<string> {
  const basename = path.basename(targetPath);
  const baseParams = {
    rootReal: root.rootReal,
    rootIdentity: root.rootIdentity,
    targetPath: path.dirname(targetPath),
    assertBeforeMutation,
  };
  const mutationWalk = mutationAdmission
    ? mutationWalkOptions(
      mutationAdmission,
      (prospectiveParent) => path.join(prospectiveParent, basename),
      assertBeforeMutation,
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
): Promise<void> {
  const baseParams = {
    rootReal: resolved.rootReal, targetPath: resolved.resolved, assertBeforeMutation,
    rootIdentity: root.rootIdentity,
    rejectSymlinks,
    beforeComponent: async (componentPath: string) => await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath),
  };
  const mutationWalk = mutationAdmission
    ? mutationWalkOptions(
      mutationAdmission,
      (prospectiveDirectory) => prospectiveDirectory,
      assertBeforeMutation,
    )
    : undefined;
  try {
    await mkdirPathComponentsWithGuards(mutationWalk ? {
      ...baseParams,
      ...mutationWalk.options,
      rejectSymlinks: rejectSymlinks || mutationAdmission!.rejectParentSymlinks,
    } : baseParams);
  } finally {
    mutationWalk?.dispose();
  }
}
