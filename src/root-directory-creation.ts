import path from "node:path";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import type { RootContext } from "./root-context.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export async function prepareRootWriteTarget(
  root: RootContext,
  targetPath: string,
  assertBeforeMutation?: () => void,
): Promise<string> {
  const parentPath = await mkdirPathComponentsWithGuards({
    rootReal: root.rootReal,
    rootIdentity: root.rootIdentity,
    targetPath: path.dirname(targetPath),
    assertBeforeMutation,
  });
  // Continue through the guarded walk's real parent instead of re-entering
  // the original path through a symlinked component.
  return path.join(parentPath, path.basename(targetPath));
}

export async function mkdirPathFallback(
  root: RootContext,
  resolved: { rootReal: string; resolved: string },
  assertBeforeMutation?: () => void,
  rejectSymlinks = false,
): Promise<void> {
  await mkdirPathComponentsWithGuards({
    rootReal: resolved.rootReal, targetPath: resolved.resolved, assertBeforeMutation,
    rootIdentity: root.rootIdentity,
    rejectSymlinks,
    beforeComponent: async (componentPath) => await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath),
  });
}
