import path from "node:path";
import { assertMutationNotDenied, type DenyMutationPolicy } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { isPathInside } from "./path.js";
import type { PinnedWriteMutationAdmission } from "./pinned-write.js";
import { resolvePathViaExistingAncestor } from "./root-path-existing.js";
import { outsideWorkspaceError } from "./root-errors.js";
import type { MutationSymlinkPolicy } from "./root-symlink-policy.js";

export type PinnedMutationPolicySnapshot = Readonly<{
  denyMutations?: DenyMutationPolicy;
  mutationSymlinks?: MutationSymlinkPolicy;
}>;

export function snapshotPinnedMutationPolicy(
  denyMutations: DenyMutationPolicy | undefined,
  mutationSymlinks: MutationSymlinkPolicy | undefined,
): PinnedMutationPolicySnapshot | undefined {
  if (denyMutations === undefined && mutationSymlinks === undefined) return undefined;
  const denySnapshot = denyMutations === undefined ? undefined : Object.freeze({
    paths: denyMutations.paths === undefined ? undefined : Object.freeze([...denyMutations.paths]),
    prefixes: denyMutations.prefixes === undefined ? undefined : Object.freeze([...denyMutations.prefixes]),
  });
  return Object.freeze({ denyMutations: denySnapshot, mutationSymlinks });
}

async function canonicalMutationEntryPath(targetPath: string): Promise<string> {
  const canonicalParent = await resolvePathViaExistingAncestor(path.dirname(targetPath));
  return path.join(canonicalParent, path.basename(targetPath));
}

function sameAbsolutePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

export async function preparePinnedWriteMutationAdmission(params: {
  rootReal: string;
  rootWithSep: string;
  resolvedTargetPath: string;
  defaultRelativeParentPath: string;
  policy: PinnedMutationPolicySnapshot | undefined;
  resolveCurrent(): Promise<{ resolved: string }>;
}): Promise<{
  relativeParentPath: string;
  mutationAdmission?: PinnedWriteMutationAdmission;
}> {
  if (!params.policy) {
    return { relativeParentPath: params.defaultRelativeParentPath };
  }
  const policy = params.policy;
  const canonicalParent = await resolvePathViaExistingAncestor(path.dirname(params.resolvedTargetPath));
  if (!isPathInside(params.rootWithSep, canonicalParent)) throw outsideWorkspaceError();
  const relativeCanonicalParent = path.relative(params.rootReal, canonicalParent);
  if (path.isAbsolute(relativeCanonicalParent) || relativeCanonicalParent.split(path.sep)[0] === "..") {
    throw outsideWorkspaceError();
  }
  const mutationAdmission: PinnedWriteMutationAdmission = Object.freeze({
    rejectParentSymlinks: policy.mutationSymlinks === "reject",
    async authorize(request) {
      // Preserve the original route's symlink/deny error ordering, then apply
      // the same snapshot to the object-bound destination selected below.
      const current = await params.resolveCurrent();
      await assertMutationNotDenied(request.targetPath, policy.denyMutations);
      if (!sameAbsolutePath(request.targetPath, request.mutationPath)) {
        await assertMutationNotDenied(request.mutationPath, policy.denyMutations);
      }
      const [currentTarget, admittedTarget] = await Promise.all([
        canonicalMutationEntryPath(current.resolved),
        canonicalMutationEntryPath(request.targetPath),
      ]);
      if (!sameAbsolutePath(currentTarget, admittedTarget)) {
        throw new FsSafeError("path-mismatch", "write target changed during mutation policy admission");
      }
    },
  });
  return {
    relativeParentPath: relativeCanonicalParent
      ? relativeCanonicalParent.split(path.sep).join(path.posix.sep)
      : "",
    mutationAdmission,
  };
}
