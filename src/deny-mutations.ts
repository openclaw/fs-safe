import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isPathInside } from "./path.js";
import { resolvePathViaExistingAncestor } from "./root-path-existing.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export async function resolveMutationComparablePaths(rawPath: string): Promise<Set<string>> {
  assertNoNulPathInput(rawPath, "path contains a NUL byte");
  assertNoWindowsPathAlias(rawPath, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  const resolved = resolvePathPreservingWindowsRoot(rawPath);
  assertNoWindowsPathAlias(resolved, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  const canonical = await resolvePathViaExistingAncestor(resolved);
  assertNoWindowsPathAlias(canonical, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  return new Set([resolved, canonical]);
}

function isSamePath(left: string, right: string): boolean {
  return isPathInside(left, right) && isPathInside(right, left);
}

export type DenyMutationPolicy = {
  paths?: readonly string[];
  prefixes?: readonly string[];
};

type DenyMutationCheckOptions = {
  protectAncestors?: boolean;
};

function hasPolicyEntries(policy: DenyMutationPolicy | undefined): policy is DenyMutationPolicy {
  return Boolean(policy?.paths?.length || policy?.prefixes?.length);
}

function policyPathEntries(entries: readonly string[] | undefined): string[] {
  const paths: string[] = [];
  for (const entry of entries ?? []) {
    if (entry.length === 0) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be non-empty");
    }
    assertNoNulPathInput(entry, "deny mutation path contains a NUL byte");
    assertNoWindowsPathAlias(entry, "filesystem", "deny mutation path uses a Windows filesystem namespace alias");
    if (!path.isAbsolute(entry)) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be absolute");
    }
    paths.push(entry);
  }
  return paths;
}

export async function assertMutationNotDenied(
  filePath: string,
  policy: DenyMutationPolicy | undefined,
  options: DenyMutationCheckOptions = {},
): Promise<void> {
  if (!hasPolicyEntries(policy)) {
    return;
  }

  const targetPaths = await resolveMutationComparablePaths(filePath);
  for (const deniedPath of policyPathEntries(policy.paths)) {
    const deniedPaths = await resolveMutationComparablePaths(deniedPath);
    for (const target of targetPaths) {
      for (const denied of deniedPaths) {
        if (
          isSamePath(denied, target) ||
          (options.protectAncestors === true && isPathInside(target, denied))
        ) {
          throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
        }
      }
    }
  }

  for (const deniedPrefix of policyPathEntries(policy.prefixes)) {
    const deniedPaths = await resolveMutationComparablePaths(deniedPrefix);
    for (const target of targetPaths) {
      for (const denied of deniedPaths) {
        if (
          isPathInside(denied, target) ||
          (options.protectAncestors === true && isPathInside(target, denied))
        ) {
          throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
        }
      }
    }
  }
}

export function mergeDenyMutationPolicies(
  defaultPolicy: DenyMutationPolicy | undefined,
  callPolicy: DenyMutationPolicy | undefined,
): DenyMutationPolicy | undefined {
  if (!defaultPolicy) {
    return callPolicy;
  }
  if (!callPolicy) {
    return defaultPolicy;
  }
  return {
    paths: [...(defaultPolicy.paths ?? []), ...(callPolicy.paths ?? [])],
    prefixes: [...(defaultPolicy.prefixes ?? []), ...(callPolicy.prefixes ?? [])],
  };
}
