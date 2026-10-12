import fs from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import type { PinnedMutationPolicySnapshot } from "./pinned-mutation-admission.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { pathForWindowsFilesystem } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";
import { isSafePathSegment } from "./safe-path-segment.js";

export type Creation = {
  root: RootContext;
  directory: string;
  target: string;
  mkdir: boolean;
  private?: boolean;
  policy?: PinnedMutationPolicySnapshot;
  resolveCurrent(): Promise<string>;
  assertBeforeMutation?: () => void;
  originalPath?: string;
  selectedParent?: NonNullable<ReturnType<typeof existingCreationParent>>;
};


export function existingCreationParent(params: Creation) {
  if (params.private || params.policy || params.assertBeforeMutation !== undefined ||
    getFsSafeTestHooks()?.beforeRootFallbackMutation || !params.originalPath ||
    params.directory !== path.dirname(params.target)) return undefined;
  const segments = params.originalPath.split(path.sep === "\\" ? /[\\/]/ : "/");
  if (segments.some(segment => !isSafePathSegment(segment, { allowDotPrefix: true }) || segment.endsWith(".")) ||
    path.join(params.root.rootReal, ...segments) !== params.target) return undefined;
  let rootStat!: fs.BigIntStats;
  assertRootIdentityCurrentSync(params.root, stat => { rootStat = stat; });
  try {
    const identity = inspectDirectoryIdentitySync(params.directory, undefined,
      params.directory === params.root.rootReal ? rootStat : undefined);
    if (realpathSync.native(pathForWindowsFilesystem(params.directory)) !== params.directory) return undefined;
    return {
      path: params.directory, identity,
      relative: path.relative(params.root.rootReal, params.directory).split(path.sep).join("/"),
      flags: (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) |
        (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    };
  } catch {
    return undefined;
  }
}

export function probeNativeCreationPath(root: RootContext, relativePath: string) {
  if (typeof relativePath !== "string") return undefined;
  const segments = relativePath.split(path.sep === "\\" ? /[\\/]/ : "/");
  if (segments.some(segment => !isSafePathSegment(segment, { allowDotPrefix: true }) || segment.endsWith("."))) return undefined;
  const target = path.join(root.rootReal, ...segments);
  assertRootIdentityCurrentSync(root);
  try {
    if (fs.lstatSync(pathForWindowsFilesystem(target), { throwIfNoEntry: false })) return undefined;
  } catch { return undefined; }
  const parent = existingCreationParent({ root, target, directory: path.dirname(target), mkdir: true,
    originalPath: relativePath, resolveCurrent: async () => target });
  if (!parent) return undefined;
  return { rootReal: root.rootReal, rootWithSep: root.rootWithSep, resolved: target, parent };
}

