import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isNotFoundPathError, isPathInside } from "./path.js";
import { realpathSync } from "./realpath.js";
import { resolveExistingAncestor } from "./root-path-existing.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export function resolveMutationComparablePaths(rawPath: string): Set<string> {
  assertNoNulPathInput(rawPath, "path contains a NUL byte");
  assertNoWindowsPathAlias(rawPath, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  const resolved = resolvePathPreservingWindowsRoot(rawPath);
  assertNoWindowsPathAlias(resolved, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  const canonical = resolveExistingAncestor(resolved, "native");
  assertNoWindowsPathAlias(canonical, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  return new Set([resolved, canonical]);
}

function strictMutationComparablePaths(pathname: string): readonly string[] {
  const resolved = resolvePathPreservingWindowsRoot(pathname);
  assertNoWindowsPathAlias(resolved, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  let cursor = resolved;
  const filesystemRoot = path.parse(resolved).root;
  while (cursor !== filesystemRoot) {
    try {
      fs.lstatSync(pathForWindowsFilesystem(cursor));
      break;
    } catch (error) {
      if (!isNotFoundPathError(error)) throw error;
      cursor = path.dirname(cursor);
    }
  }
  // Synchronous Root locks require authority-grade canonicalization. Keep
  // ambiguous existing ancestors distinct from Root's lexical fallback.
  const canonicalAncestor = realpathSync.native(pathForWindowsFilesystem(cursor));
  assertNoWindowsPathAlias(canonicalAncestor, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  const canonical = cursor === resolved
    ? canonicalAncestor
    : path.resolve(canonicalAncestor, `.${path.sep}${resolved.slice(cursor.length)}`);
  assertNoWindowsPathAlias(canonical, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  return path.relative(path.resolve(resolved), path.resolve(canonical)) === ""
    ? [resolved] : [resolved, canonical];
}

export type DenyMutationPolicy = {
  paths?: readonly string[];
  prefixes?: readonly string[];
};

type DenyMutationCheckOptions = {
  protectAncestors?: boolean;
};

function policyPathEntries(entries: readonly string[] | undefined, strict: boolean): string[] {
  const paths: string[] = [];
  for (const entry of entries ?? []) {
    if (strict && (!entry || !path.isAbsolute(entry))) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be non-empty absolute paths");
    }
    if (entry.length === 0) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be non-empty");
    }
    assertNoNulPathInput(entry, "deny mutation path contains a NUL byte");
    assertNoWindowsPathAlias(entry, "filesystem", "deny mutation path uses a Windows filesystem namespace alias");
    if (!strict && !path.isAbsolute(entry)) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be absolute");
    }
    paths.push(strict ? resolvePathPreservingWindowsRoot(entry) : entry);
  }
  return paths;
}

export function assertMutationNotDenied(
  filePath: string,
  policy: DenyMutationPolicy | undefined,
  options: DenyMutationCheckOptions = {},
  mode: "root" | "sync-root-lock" = "root",
): void {
  if (!policy?.paths?.length && !policy?.prefixes?.length) return;
  const strict = mode === "sync-root-lock";
  const comparablePaths = strict ? strictMutationComparablePaths : resolveMutationComparablePaths;
  const targets = comparablePaths(filePath);
  // Validate one complete phase at a time. A paths denial must not read or
  // canonicalize prefixes, and invalid later paths retain validation precedence.
  for (const kind of ["paths", "prefixes"] as const) {
    for (const entry of policyPathEntries(policy[kind], strict)) {
      const deniedPaths = comparablePaths(entry);
      for (const target of targets) {
        for (const denied of deniedPaths) {
          if ((isPathInside(denied, target) && (kind === "prefixes" || isPathInside(target, denied))) ||
            (options.protectAncestors === true && isPathInside(target, denied))) {
            throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
          }
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
