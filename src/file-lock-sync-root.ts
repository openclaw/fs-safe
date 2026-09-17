import fs from "node:fs";
import path from "node:path";
import { type DenyMutationPolicy } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isNotFoundPathError, isPathInside } from "./path.js";
import { resolveRootPathSync } from "./root-path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import {
  assertRootIdentityCurrentSync,
  type RootContext,
} from "./root-context.js";
import {
  directoryComponentNotDirectoryError,
  outsideWorkspaceError,
} from "./root-errors.js";
import type { Root, RootDefaults } from "./root-impl.js";
import {
  mutationSymlinkResolution,
  readSymlinkResolution,
} from "./root-symlink-policy.js";
import { realpathSync } from "./realpath.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

const retainedRootContexts = new WeakMap<object, RootContext>();
const retainedRootDefaults = new WeakMap<object, RootDefaults>();

/** @internal Registers only instances constructed by RootHandle itself. */
export function registerFileLockSyncRootAdapter(
  handle: object,
  context: RootContext,
  defaults: RootDefaults,
): void {
  const identity = context.rootIdentity;
  if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") return;
  // Retain the already-created Root inputs directly. Registration adds no
  // per-Root wrapper/context allocations for callers that never use sync locks.
  retainedRootContexts.set(handle, context);
  retainedRootDefaults.set(handle, defaults);
}

export type FileLockSyncRootAuthority = Readonly<{
  adapter: object;
  context: RootContext;
  assertBeforeMutation?: () => void;
  denyMutations?: Readonly<{
    paths?: readonly string[];
    prefixes?: readonly string[];
  }>;
  hardlinks?: RootDefaults["hardlinks"];
  mutationSymlinks?: RootDefaults["mutationSymlinks"];
  symlinks?: RootDefaults["symlinks"];
}>;

export type FileLockSyncRootPath = Readonly<{
  authority: FileLockSyncRootAuthority;
  path: string;
  relativePath: string;
}>;

function snapshotPolicy(
  policy: DenyMutationPolicy | undefined,
): FileLockSyncRootAuthority["denyMutations"] {
  if (policy === undefined) return undefined;
  const paths = policy.paths;
  const prefixes = policy.prefixes;
  return Object.freeze({
    paths: paths === undefined ? undefined : Object.freeze([...paths]),
    prefixes: prefixes === undefined ? undefined : Object.freeze([...prefixes]),
  });
}

export function captureFileLockSyncRootAuthority(
  lockRoot: Root,
): FileLockSyncRootAuthority {
  const adapter = lockRoot as object;
  const retainedContext = retainedRootContexts.get(adapter);
  const retainedDefaults = retainedRootDefaults.get(adapter);
  if (!retainedContext || !retainedDefaults) {
    throw new FsSafeError(
      "helper-unavailable",
      "synchronous Root-backed file locks require a genuine fs-safe Root handle",
    );
  }
  const identity = retainedContext.rootIdentity;
  if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
    throw new FsSafeError("helper-unavailable", "synchronous Root identity is unavailable");
  }
  const context = Object.freeze({
    rootDir: retainedContext.rootDir,
    rootGuard: retainedContext.rootGuard,
    rootIdentity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
    rootReal: retainedContext.rootReal,
    rootWithSep: retainedContext.rootWithSep,
  });
  const defaults = retainedDefaults;
  const authority = Object.freeze({
    adapter,
    context,
    assertBeforeMutation: defaults.assertBeforeMutation,
    denyMutations: snapshotPolicy(defaults.denyMutations),
    hardlinks: defaults.hardlinks,
    mutationSymlinks: defaults.mutationSymlinks,
    symlinks: defaults.symlinks,
  });
  // Validate the retained object before any caller callback or filesystem effect.
  assertRootIdentityCurrentSync(authority.context);
  mutationSymlinkResolution(authority.mutationSymlinks);
  readSymlinkResolution(authority.symlinks);
  return authority;
}

export function sameFileLockSyncRootAuthority(
  left: FileLockSyncRootAuthority,
  right: FileLockSyncRootAuthority,
): boolean {
  return left.adapter === right.adapter;
}

export function invokeFileLockSyncRootMutationAuthority(
  authority: FileLockSyncRootAuthority,
): boolean {
  const assertion = authority.assertBeforeMutation;
  if (!assertion) return false;
  // Match Root mutation semantics: callbacks are invoked unbound and a
  // thenable result cannot authorize a synchronous filesystem mutation.
  assertSynchronousCallbackResult(assertion(), "assertBeforeMutation");
  return true;
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function absoluteRootPath(
  authority: FileLockSyncRootAuthority,
  relativePath: string,
): string {
  const segments = relativePath.split(path.posix.sep);
  const absolute = path.join(authority.context.rootReal, ...segments);
  assertNoWindowsPathAlias(absolute, "filesystem", "sidecar lock path uses a Windows filesystem namespace alias");
  return absolute;
}

function assertValidPolicyEntries(entries: readonly string[] | undefined): string[] {
  const captured: string[] = [];
  for (const entry of entries ?? []) {
    if (!entry || !path.isAbsolute(entry)) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be non-empty absolute paths");
    }
    assertNoNulPathInput(entry, "deny mutation path contains a NUL byte");
    assertNoWindowsPathAlias(entry, "filesystem", "deny mutation path uses a Windows filesystem namespace alias");
    captured.push(resolvePathPreservingWindowsRoot(entry));
  }
  return captured;
}

function mutationComparablePaths(pathname: string): readonly string[] {
  const resolved = resolvePathPreservingWindowsRoot(pathname);
  assertNoWindowsPathAlias(resolved, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  let cursor = resolved;
  const missing: string[] = [];
  while (path.parse(cursor).root !== cursor) {
    try {
      fs.lstatSync(pathForWindowsFilesystem(cursor));
      break;
    } catch (error) {
      if (!isNotFoundPathError(error)) throw error;
      missing.unshift(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
  // Deny policy is an authority boundary: unlike advisory key normalization,
  // an ambiguous existing ancestor must not silently fall back to lexical form.
  const canonicalAncestor = realpathSync.native(pathForWindowsFilesystem(cursor));
  assertNoWindowsPathAlias(canonicalAncestor, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  const canonical = missing.length === 0
    ? canonicalAncestor
    : path.resolve(canonicalAncestor, ...missing);
  assertNoWindowsPathAlias(canonical, "filesystem", "mutation path uses a Windows filesystem namespace alias");
  return samePath(resolved, canonical) ? [resolved] : [resolved, canonical];
}

export function assertFileLockSyncRootMutationAllowed(
  pathname: string,
  policy: FileLockSyncRootAuthority["denyMutations"],
  protectAncestors = false,
): void {
  if (!policy?.paths?.length && !policy?.prefixes?.length) return;
  const targets = mutationComparablePaths(pathname);
  for (const entry of assertValidPolicyEntries(policy.paths)) {
    for (const denied of mutationComparablePaths(entry)) {
      for (const target of targets) {
        if ((isPathInside(denied, target) && isPathInside(target, denied)) ||
          (protectAncestors && isPathInside(target, denied))) {
          throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
        }
      }
    }
  }
  for (const entry of assertValidPolicyEntries(policy.prefixes)) {
    for (const denied of mutationComparablePaths(entry)) {
      for (const target of targets) {
        if (isPathInside(denied, target) || (protectAncestors && isPathInside(target, denied))) {
          throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
        }
      }
    }
  }
}

type RootPathResolutionPolicy = Readonly<{
  rejectSymlinks?: boolean;
  rejectFinalSymlink?: boolean;
  rejectUnresolvedSymlinks: true;
}>;

function mutationResolutionPolicy(
  authority: FileLockSyncRootAuthority,
): RootPathResolutionPolicy {
  const policy = mutationSymlinkResolution(authority.mutationSymlinks);
  return {
    rejectSymlinks: policy.rejectSymlinks,
    rejectFinalSymlink: policy.rejectFinalSymlink,
    rejectUnresolvedSymlinks: true,
  };
}

function readResolutionPolicy(
  authority: FileLockSyncRootAuthority,
): RootPathResolutionPolicy {
  return { ...readSymlinkResolution(authority.symlinks), rejectUnresolvedSymlinks: true };
}

function sameResolutionPolicy(
  left: RootPathResolutionPolicy,
  right: RootPathResolutionPolicy,
): boolean {
  return left.rejectSymlinks === right.rejectSymlinks &&
    left.rejectFinalSymlink === right.rejectFinalSymlink;
}

function resolveAdmittedPath(
  authority: FileLockSyncRootAuthority,
  absolutePath: string,
  policy: RootPathResolutionPolicy,
  rootPath: string,
): { path: string; relativePath: string } {
  const context = authority.context;
  const resolved = resolveRootPathSync({
    absolutePath,
    // The shared resolver identity-gates ambiguous Windows matches against the
    // original Root spelling before rebasing them to the retained canonical root.
    rootPath,
    rootCanonicalPath: context.rootReal,
    rootIdentity: context.rootIdentity,
    boundaryLabel: "sidecar lock root",
    ...policy,
  });
  const admitted = admitPathInsideRoot({
    rootPath: context.rootReal,
    candidatePath: resolved.canonicalPath,
    rootIdentity: context.rootIdentity,
  });
  if (!admitted || admitted.relativePath === "" || samePath(admitted.path, context.rootReal)) {
    throw outsideWorkspaceError();
  }
  return {
    path: admitted.path,
    relativePath: admitted.relativePath.split(path.sep).join(path.posix.sep),
  };
}

function resolveBothPolicies(
  authority: FileLockSyncRootAuthority,
  absolutePath: string,
  rootPath: string,
): { path: string; relativePath: string } {
  const mutationPolicy = mutationResolutionPolicy(authority);
  const readPolicy = readResolutionPolicy(authority);
  const mutation = resolveAdmittedPath(
    authority,
    absolutePath,
    mutationPolicy,
    rootPath,
  );
  const readable = sameResolutionPolicy(mutationPolicy, readPolicy)
    ? mutation
    : resolveAdmittedPath(authority, absolutePath, readPolicy, rootPath);
  if (!samePath(mutation.path, readable.path)) {
    throw new FsSafeError("path-mismatch", "sidecar read and mutation paths resolve differently");
  }
  assertFileLockSyncRootMutationAllowed(mutation.path, authority.denyMutations);
  return mutation;
}

function admitRequestedRootPrefix(
  authority: FileLockSyncRootAuthority,
  requestedPath: string,
): { path: string; rootPath: string } {
  const context = authority.context;
  const identityCache = process.platform === "win32" ? new Map<string, boolean>() : undefined;
  const original = admitPathInsideRoot({
    rootPath: context.rootDir,
    candidatePath: requestedPath,
    rootIdentity: context.rootIdentity,
    resolveCandidateRoot: context.rootDir !== context.rootReal,
    identityCache,
  });
  if (original && original.relativePath !== "") {
    return { path: original.path, rootPath: context.rootDir };
  }
  const canonical = context.rootDir === context.rootReal ? undefined : admitPathInsideRoot({
    rootPath: context.rootReal,
    candidatePath: requestedPath,
    rootIdentity: context.rootIdentity,
    identityCache,
  });
  if (!canonical || canonical.relativePath === "") throw outsideWorkspaceError();
  return { path: canonical.path, rootPath: context.rootReal };
}

export function admitFileLockSyncRootPath(
  authority: FileLockSyncRootAuthority,
  requestedPath: string,
): FileLockSyncRootPath {
  assertNoNulPathInput(requestedPath, "sidecar lock path contains a NUL byte");
  const resolved = resolvePathPreservingWindowsRoot(requestedPath);
  assertNoWindowsPathAlias(resolved, "filesystem", "sidecar lock path uses a Windows filesystem namespace alias");
  assertRootIdentityCurrentSync(authority.context);
  const prefixed = admitRequestedRootPrefix(authority, resolved);
  const selected = resolveBothPolicies(authority, prefixed.path, prefixed.rootPath);
  assertRootIdentityCurrentSync(authority.context);
  const admitted = Object.freeze({
    authority,
    path: selected.path,
    relativePath: selected.relativePath,
  });
  assertMissingParentMutationsAllowed(admitted);
  return admitted;
}

export function assertFileLockSyncRootResolvedPathCurrent(
  pathAuthority: FileLockSyncRootPath,
): void {
  const resolved = resolveBothPolicies(
    pathAuthority.authority,
    absoluteRootPath(pathAuthority.authority, pathAuthority.relativePath),
    pathAuthority.authority.context.rootReal,
  );
  if (!samePath(resolved.path, pathAuthority.path)) {
    throw new FsSafeError("path-mismatch", "sidecar lock path changed during operation");
  }
}

function assertMissingParentMutationsAllowed(pathAuthority: FileLockSyncRootPath): void {
  const authority = pathAuthority.authority;
  const context = authority.context;
  const relativeParent = path.posix.dirname(pathAuthority.relativePath);
  const relative = relativeParent === "." ? "" : relativeParent;
  let current = context.rootReal;
  let missing = false;
  for (const segment of relative.split(path.posix.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!missing) {
      try {
        const stat = fs.lstatSync(pathForWindowsFilesystem(current), { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
      } catch (error) {
        if (!isNotFoundPathError(error)) throw error;
        missing = true;
      }
    }
    if (missing) assertFileLockSyncRootMutationAllowed(current, authority.denyMutations);
  }
}

export function assertFileLockSyncRootPathsCurrent(
  paths: readonly FileLockSyncRootPath[],
  invokeAuthority = false,
  pathsAlreadyCurrent = false,
): void {
  const authority = paths[0]?.authority;
  for (const pathAuthority of paths) {
    if (authority && pathAuthority.authority !== authority) {
      throw new FsSafeError("path-mismatch", "sidecar paths use different Root authority");
    }
  }
  if (!pathsAlreadyCurrent) {
    if (authority) assertRootIdentityCurrentSync(authority.context);
    for (const pathAuthority of paths) {
      assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
      assertMissingParentMutationsAllowed(pathAuthority);
    }
    if (authority) assertRootIdentityCurrentSync(authority.context);
  }
  if (invokeAuthority && authority && invokeFileLockSyncRootMutationAuthority(authority)) {
    assertRootIdentityCurrentSync(authority.context);
    for (const pathAuthority of paths) {
      assertFileLockSyncRootResolvedPathCurrent(pathAuthority);
      assertMissingParentMutationsAllowed(pathAuthority);
    }
    assertRootIdentityCurrentSync(authority.context);
  }
}

function resolveTargetPathViaExistingAncestorSync(targetPath: string): string {
  const normalized = resolvePathPreservingWindowsRoot(targetPath);
  const canonicalize = process.platform === "win32" ? realpathSync.native : realpathSync;
  let cursor = normalized;
  const missing: string[] = [];
  while (true) {
    try {
      fs.lstatSync(pathForWindowsFilesystem(cursor));
      try {
        const canonicalAncestor = canonicalize(pathForWindowsFilesystem(cursor));
        assertNoWindowsPathAlias(canonicalAncestor, "filesystem", "file-lock target ancestor uses a Windows filesystem namespace alias");
        return missing.length === 0
          ? resolvePathPreservingWindowsRoot(canonicalAncestor)
          : resolvePathPreservingWindowsRoot(path.resolve(canonicalAncestor, ...missing));
      } catch (error) {
        if (!isNotFoundPathError(error)) throw error;
        // A dangling link is an existing lexical entry but not a canonical
        // ancestor. Continue at its parent instead of abandoning native
        // long/short-name normalization for the rest of the target path.
      }
    } catch (error) {
      if (!isNotFoundPathError(error)) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      // Filesystem roots are expected to exist; preserve the underlying
      // not-found diagnosis if a synthetic namespace violates that premise.
      const canonicalAncestor = canonicalize(pathForWindowsFilesystem(cursor));
      assertNoWindowsPathAlias(canonicalAncestor, "filesystem", "file-lock target ancestor uses a Windows filesystem namespace alias");
      return missing.length === 0
        ? resolvePathPreservingWindowsRoot(canonicalAncestor)
        : resolvePathPreservingWindowsRoot(path.resolve(canonicalAncestor, ...missing));
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}

export function normalizeFileLockSyncTargetWithRoot(
  authority: FileLockSyncRootAuthority,
  resolvedTargetPath: string,
): string {
  assertNoNulPathInput(resolvedTargetPath, "file-lock target contains a NUL byte");
  assertNoWindowsPathAlias(resolvedTargetPath, "filesystem", "file-lock target uses a Windows filesystem namespace alias");
  assertRootIdentityCurrentSync(authority.context);
  // Preserve POSIX's pathname-key behavior while making Windows resolve the
  // complete existing prefix (including an existing 8.3-spelled filename).
  const normalized = process.platform === "win32"
    ? resolveTargetPathViaExistingAncestorSync(resolvedTargetPath)
    : path.join(
        resolveTargetPathViaExistingAncestorSync(path.dirname(resolvedTargetPath)),
        path.basename(resolvedTargetPath),
      );
  assertNoWindowsPathAlias(normalized, "filesystem", "file-lock target uses a Windows filesystem namespace alias");
  assertRootIdentityCurrentSync(authority.context);
  return normalized;
}
