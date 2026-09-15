import path from "node:path";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import type { PinnedWriteMutationAdmission } from "./pinned-write.js";
import type { RootContext } from "./root-context.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function mutationWalkOptions(
  mutationAdmission: PinnedWriteMutationAdmission,
  operationTarget: (prospectiveDirectory: string) => string,
) {
  return {
    rejectSymlinks: mutationAdmission.rejectParentSymlinks,
    revalidateParentAfterBeforeComponent: true,
    beforeCreateComponent: async (
      componentPath: string,
      prospectiveDirectory: string,
    ) => {
      const targetPath = operationTarget(prospectiveDirectory);
      await mutationAdmission.authorize(Object.freeze({
        targetPath,
        mutationPath: componentPath,
        phase: "parent-create" as const,
      }));
      // The shared pathname fallback deliberately retains full ordered
      // authorization. Receipt shortcuts stay exclusive to pinned writers.
      return undefined;
    },
    beforeUseComponent: async (
      _componentPath: string,
      prospectiveDirectory: string,
    ) => {
      const targetPath = operationTarget(prospectiveDirectory);
      await mutationAdmission.authorize(Object.freeze({
        targetPath,
        mutationPath: targetPath,
        phase: "parent" as const,
      }));
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
  const parentPath = await mkdirPathComponentsWithGuards(mutationAdmission ? {
    ...baseParams,
    ...mutationWalkOptions(
      mutationAdmission,
      (prospectiveParent) => path.join(prospectiveParent, basename),
    ),
  } : baseParams);
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
  await mkdirPathComponentsWithGuards(mutationAdmission ? {
    ...baseParams,
    ...mutationWalkOptions(mutationAdmission, (prospectiveDirectory) => prospectiveDirectory),
    rejectSymlinks: rejectSymlinks || mutationAdmission.rejectParentSymlinks,
  } : baseParams);
}
