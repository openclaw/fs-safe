import path from "node:path";
import { assertMutationNotDenied, type DenyMutationPolicy } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { isPathInside } from "./path.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";
import type {
  PinnedCreatedDirectoryReceipt,
  PinnedMutationAdmissionReceipt,
  PinnedMutationAuthorizationToken,
  PinnedWriteMutationAdmission,
} from "./pinned-write.js";
import { resolvePathViaExistingAncestor } from "./root-path-existing.js";
import { outsideWorkspaceError } from "./root-errors.js";
import type { MutationSymlinkPolicy } from "./root-symlink-policy.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import {
  advanceMutationObservation, mutationObservationCurrent, observeMutationPath,
  mutationDirectoryObservationCurrent, mutationObservationUsesDirectory,
  missingMutationSegments, nextMissingMutationPath,
  type MutationPathObservation,
} from "./pinned-mutation-observation.js";

type AdmissionRequest = Parameters<PinnedWriteMutationAdmission["authorize"]>[0];
type Epoch = Readonly<{
  mode: string;
  observations: readonly MutationPathObservation[];
  target: MutationPathObservation;
  paths: readonly (readonly string[])[];
  prefixes: readonly (readonly string[])[];
}>;
type CreateReceipt = PinnedMutationAdmissionReceipt & Readonly<{
  epoch: Epoch;
  childPath: string;
}>;

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

function simpleRoute(rootReal: string, originalPath: string | undefined): string | undefined {
  // These routes can depend on raw traversal, platform aliases, home expansion,
  // or live native canonicalization. They retain full admission at every step.
  if (!originalPath || process.platform === "win32" || process.versions.bun ||
    originalPath.startsWith("~") || originalPath.includes("\\") || originalPath.includes("\0")) return undefined;
  const segments = originalPath.split("/");
  if (segments.some((segment, index) => segment === "." || segment === ".." ||
    (segment === "" && index !== 0))) return undefined;
  const target = path.resolve(rootReal, originalPath);
  return isPathInside(rootReal, target) && target !== rootReal ? target : undefined;
}

function captureEpoch(rootReal: string, target: string, policy: PinnedMutationPolicySnapshot): Epoch | undefined {
  const observations = new Map<string, MutationPathObservation>();
  const observe = (pathname: string) => {
    if (!observations.has(pathname)) {
      const observation = observeMutationPath(pathname);
      if (!observation) throw new Error("incomplete mutation observation");
      observations.set(pathname, observation);
    }
    return observations.get(pathname)!;
  };
  try {
    const root = observe(rootReal);
    const route = observe(target);
    // A canonical spelling alone cannot certify a route containing aliases.
    if (root.canonicalPath !== rootReal || route.canonicalPath !== target ||
      route.ancestor !== route.canonicalAncestor || route.entry.dev !== route.identity.dev ||
      route.entry.ino !== route.identity.ino) return undefined;
    const comparables = (entries: readonly string[] | undefined) => Object.freeze((entries ?? []).map((entry) => {
      if (!entry || !path.isAbsolute(entry) || entry.includes("\0")) throw new Error("invalid policy observation");
      const resolved = path.resolve(entry);
      return Object.freeze([resolved, observe(resolved).canonicalPath]);
    }));
    const paths = comparables(policy.denyMutations?.paths);
    const prefixes = comparables(policy.denyMutations?.prefixes);
    return Object.freeze({
      mode: getFsSafeNativeConfig().mode, target: route, paths, prefixes,
      observations: Object.freeze([...observations.values()]),
    });
  } catch {
    return undefined;
  }
}

function epochCurrent(epoch: Epoch): boolean {
  return !process.versions.bun && getFsSafeNativeConfig().mode === epoch.mode &&
    epoch.observations.every(mutationObservationCurrent);
}

function assertCachedNotDenied(target: string, epoch: Epoch): void {
  if (epoch.paths.some((paths) => paths.some((denied) =>
    isPathInside(denied, target) && isPathInside(target, denied))) ||
    epoch.prefixes.some((paths) => paths.some((denied) => isPathInside(denied, target)))) {
    throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
  }
}

function reusableRequest(request: AdmissionRequest, epoch: Epoch): boolean {
  return request.targetPath === epoch.target.path &&
    ((request.phase === "parent" && request.mutationPath === request.targetPath) ||
      (request.phase === "parent-create" && missingMutationSegments(epoch.target) > 1 &&
        request.mutationPath === nextMissingMutationPath(epoch.target)));
}

export async function preparePinnedWriteMutationAdmission(params: {
  rootReal: string;
  rootWithSep: string;
  rootIdentity?: RootBoundaryIdentity;
  resolvedTargetPath: string;
  defaultRelativeParentPath: string;
  originalPath?: string;
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
  const route = simpleRoute(params.rootReal, params.originalPath);
  let receiptsEnabled = false;
  let epoch: Epoch | undefined;
  let pending: CreateReceipt | undefined;
  const authorizationToken: PinnedMutationAuthorizationToken = Object.freeze({});
  const observedCanonicalParent = await resolvePathViaExistingAncestor(path.dirname(params.resolvedTargetPath));
  const admittedCanonicalParent = admitPathInsideRoot({
    rootPath: params.rootReal,
    candidatePath: observedCanonicalParent,
    rootIdentity: params.rootIdentity,
  });
  if (!admittedCanonicalParent) throw outsideWorkspaceError();
  const relativeCanonicalParent = admittedCanonicalParent.relativePath;
  const mutationAdmission: PinnedWriteMutationAdmission = Object.freeze({
    rejectParentSymlinks: policy.mutationSymlinks === "reject",
    beginParentWalk: route ? () => {
      receiptsEnabled = true;
      return route;
    } : undefined,
    tryAuthorizeAtParent(request, parent) {
      pending = undefined;
      const reusable = epoch;
      if (!reusable || !reusableRequest(request, reusable) ||
        !mutationObservationUsesDirectory(reusable.target, parent) ||
        !epochCurrent(reusable)) {
        epoch = undefined;
        return undefined;
      }
      assertCachedNotDenied(request.targetPath, reusable);
      assertCachedNotDenied(request.mutationPath, reusable);
      // This is the required end fence. The caller can consume the returned
      // token without awaiting only while the exact pathname, canonical
      // spelling, descriptor identity, type, mode, and link count still match.
      if (!mutationDirectoryObservationCurrent(parent)) {
        epoch = undefined;
        return undefined;
      }
      if (request.phase === "parent-create") {
        pending = Object.freeze({ epoch: reusable, childPath: request.mutationPath });
        return pending;
      }
      return authorizationToken;
    },
    async authorize(request) {
      pending = undefined;
      if (epoch && reusableRequest(request, epoch) && epochCurrent(epoch)) {
        assertCachedNotDenied(request.targetPath, epoch);
        assertCachedNotDenied(request.mutationPath, epoch);
        if (request.phase === "parent-create") {
          pending = Object.freeze({ epoch, childPath: request.mutationPath });
          return pending;
        }
        return undefined;
      }
      epoch = undefined;
      const candidate = receiptsEnabled && route === request.targetPath
        ? captureEpoch(params.rootReal, route, policy) : undefined;
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
      // Observations bracket the ordered admission. Never attach a cache to
      // evidence collected only after the policy decisions it would replace.
      if (candidate && current.resolved === route && epochCurrent(candidate)) {
        epoch = candidate;
        if (request.phase === "parent-create" && reusableRequest(request, candidate)) {
          pending = Object.freeze({ epoch: candidate, childPath: request.mutationPath });
          return pending;
        }
      }
      return undefined;
    },
    advanceCreatedDirectory: route ? (receipt: PinnedCreatedDirectoryReceipt) => {
      const admitted = pending;
      pending = undefined;
      const admittedEpoch = epoch;
      // Completion is fail-closed: no partially checked candidate remains
      // reusable if any provenance, observation, or freshness check fails.
      epoch = undefined;
      if (!admittedEpoch || !admitted || receipt.admission !== admitted ||
        admitted.epoch !== admittedEpoch ||
        admitted.childPath !== receipt.child.path) {
        return undefined;
      }
      // The walker calls this only after its live parent fence, exact-parent
      // deny, authority callback, successful mkdir, and exact child checks.
      const observations = admittedEpoch.observations.map((observation) =>
        advanceMutationObservation(observation, receipt.parent, receipt.child));
      if (observations.some((observation) => !observation)) {
        return undefined;
      }
      const complete = observations as MutationPathObservation[];
      const target = complete.find((observation) => observation.path === admittedEpoch.target.path);
      if (!target || target.missingOffset !== admittedEpoch.target.missingOffset + 1) {
        return undefined;
      }
      const next = Object.freeze({
        ...admittedEpoch,
        target,
        observations: Object.freeze(complete),
      });
      if (!mutationDirectoryObservationCurrent(receipt.parent) ||
        !mutationDirectoryObservationCurrent(receipt.child) ||
        !mutationObservationUsesDirectory(target, receipt.child) ||
        !epochCurrent(next)) return undefined;
      assertCachedNotDenied(target.path, next);
      assertCachedNotDenied(receipt.child.path, next);
      epoch = next;
      return authorizationToken;
    } : undefined,
  });
  return {
    relativeParentPath: relativeCanonicalParent
      ? relativeCanonicalParent.split(path.sep).join(path.posix.sep)
      : "",
    mutationAdmission,
  };
}
