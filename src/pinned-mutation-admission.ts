import path from "node:path";
import { assertMutationNotDenied, type DenyMutationPolicy } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { isPathInside } from "./path.js";
import { requirePathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";
import type {
  PinnedCreatedDirectoryReceipt,
  PinnedMutationAdmissionReceipt,
  PinnedMutationAuthorizationToken,
  PinnedMutationParentWalkSession,
  PinnedWriteMutationAdmission,
} from "./pinned-write-types.js";
import {
  ordinarySharedAbsoluteInsideRoot,
  simpleSharedRoute,
} from "./pinned-mutation-shared-route.js";
import type { ExactRootIdentity } from "./pinned-mutation-shared-route.js";
import { resolvePathViaExistingAncestor } from "./root-path-existing.js";
import type { MutationSymlinkPolicy } from "./root-symlink-policy.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import {
  advanceMutationObservation, mutationObservationCurrent, observeMutationPath,
  mutationObservationsCurrent, mutationObservationUsesDirectory,
  missingMutationSegments, nextMissingMutationPath,
  type MutationDirectoryObservation, type MutationPathObservation,
} from "./pinned-mutation-observation.js";

type AdmissionRequest = Parameters<PinnedWriteMutationAdmission["authorize"]>[0];
type ParentWalkSession = Readonly<{
  kind: "pinned" | "shared";
  route: string;
  selectedTarget: string;
  nativeMode: string;
  rootIdentity?: ExactRootIdentity;
  authorizationToken: PinnedMutationAuthorizationToken;
}>;
type Epoch = Readonly<{
  mode: string;
  observations: readonly MutationPathObservation[];
  target: MutationPathObservation;
  paths: readonly (readonly string[])[];
  prefixes: readonly (readonly string[])[];
  session: ParentWalkSession;
}>;
type CreateReceipt = PinnedMutationAdmissionReceipt & Readonly<{
  epoch: Epoch;
  childPath: string;
  session: ParentWalkSession;
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

function simplePinnedRoute(rootReal: string, originalPath: string | undefined): string | undefined {
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

function nonzeroObservationIdentity(observation: MutationPathObservation): boolean {
  return observation.entry.dev !== 0n && observation.entry.ino !== 0n &&
    observation.identity.dev !== 0n && observation.identity.ino !== 0n;
}

function captureEpoch(
  rootReal: string,
  target: string,
  policy: PinnedMutationPolicySnapshot,
  session: ParentWalkSession,
): Epoch | undefined {
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
      if (session.kind === "shared" && (!session.rootIdentity || entry !== resolved ||
        !ordinarySharedAbsoluteInsideRoot(rootReal, resolved, session.rootIdentity))) {
        throw new Error("ineligible shared policy observation");
      }
      const observation = observe(resolved);
      if (session.kind === "shared" && (observation.canonicalPath !== resolved ||
        observation.ancestor !== observation.canonicalAncestor ||
        !nonzeroObservationIdentity(observation))) {
        throw new Error("incomplete shared policy observation");
      }
      return Object.freeze([resolved, observation.canonicalPath]);
    }));
    const paths = comparables(policy.denyMutations?.paths);
    const prefixes = comparables(policy.denyMutations?.prefixes);
    if (session.kind === "shared" && (!session.rootIdentity ||
      root.entry.dev !== session.rootIdentity.dev || root.entry.ino !== session.rootIdentity.ino ||
      root.identity.dev !== session.rootIdentity.dev || root.identity.ino !== session.rootIdentity.ino ||
      !nonzeroObservationIdentity(root) || !nonzeroObservationIdentity(route))) return undefined;
    return Object.freeze({
      mode: getFsSafeNativeConfig().mode, target: route, paths, prefixes,
      observations: Object.freeze([...observations.values()]), session,
    });
  } catch {
    return undefined;
  }
}

function epochCurrent(epoch: Epoch, directories?: readonly MutationDirectoryObservation[]): boolean {
  return !process.versions.bun && epoch.mode === epoch.session.nativeMode &&
    getFsSafeNativeConfig().mode === epoch.mode &&
    (directories ? mutationObservationsCurrent(epoch.observations, directories) :
      epoch.observations.every(mutationObservationCurrent)) &&
    getFsSafeNativeConfig().mode === epoch.mode;
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

function reusableSharedCreateRequest(request: AdmissionRequest, epoch: Epoch): boolean {
  return request.phase === "parent-create" && request.targetPath === epoch.target.path &&
    request.mutationPath === nextMissingMutationPath(epoch.target);
}

function reusableSharedRequest(request: AdmissionRequest, epoch: Epoch): boolean {
  return request.phase === "parent"
    ? request.targetPath === epoch.target.path && request.mutationPath === request.targetPath
    : reusableSharedCreateRequest(request, epoch);
}

function nonzeroDirectoryObservation(
  observation: PinnedCreatedDirectoryReceipt["parent"],
): boolean {
  return observation.identity.dev !== 0n && observation.identity.ino !== 0n;
}

function advanceAuthorizedDirectory(
  admittedEpoch: Epoch | undefined,
  admitted: CreateReceipt | undefined,
  receipt: PinnedCreatedDirectoryReceipt,
): Epoch | undefined {
  if (!admittedEpoch || !admitted || receipt.admission !== admitted ||
    admitted.epoch !== admittedEpoch || admitted.session !== admittedEpoch.session ||
    admitted.childPath !== receipt.child.path ||
    (admittedEpoch.session.kind === "shared" &&
      (!nonzeroDirectoryObservation(receipt.parent) ||
        !nonzeroDirectoryObservation(receipt.child)))) return undefined;
  // The walker calls this only after its live parent fence, exact-parent deny,
  // authority callback, successful mkdir, and exact child checks.
  const observations = admittedEpoch.observations.map((observation) =>
    advanceMutationObservation(observation, receipt.parent, receipt.child));
  if (observations.some((observation) => !observation)) return undefined;
  const complete = observations as MutationPathObservation[];
  const target = complete.find((observation) => observation.path === admittedEpoch.target.path);
  if (!target || target.missingOffset !== admittedEpoch.target.missingOffset + 1) return undefined;
  const next = Object.freeze({
    ...admittedEpoch,
    target,
    observations: Object.freeze(complete),
  });
  if (!mutationObservationUsesDirectory(target, receipt.child) ||
    !epochCurrent(next, [receipt.parent, receipt.child])) return undefined;
  assertCachedNotDenied(target.path, next);
  assertCachedNotDenied(receipt.child.path, next);
  return next;
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
  const route = simplePinnedRoute(params.rootReal, params.originalPath);
  const sharedRoute = simpleSharedRoute({
    rootReal: params.rootReal,
    rootIdentity: params.rootIdentity,
    originalPath: params.originalPath,
    selectedTarget: params.resolvedTargetPath,
    policy,
  });
  const nativeRoute = sharedRoute ?? (process.platform === "win32" && params.originalPath?.includes("/")
    ? simpleSharedRoute({ rootReal: params.rootReal, rootIdentity: params.rootIdentity,
      originalPath: params.originalPath.replaceAll("/", "\\"), selectedTarget: params.resolvedTargetPath, policy })
    : undefined);
  let pinnedSession: ParentWalkSession | undefined;
  let epoch: Epoch | undefined;
  let pending: CreateReceipt | undefined;
  const observedCanonicalParent = await resolvePathViaExistingAncestor(path.dirname(params.resolvedTargetPath));
  const admittedCanonicalParent = requirePathInsideRoot(
    params.rootReal, observedCanonicalParent, params.rootIdentity,
  );
  const relativeCanonicalParent = admittedCanonicalParent.relativePath;
  const authorizeFully = async (request: AdmissionRequest): Promise<{ resolved: string }> => {
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
    return current;
  };
  const createSharedParentWalk = (admittedRoute: NonNullable<typeof sharedRoute>): PinnedMutationParentWalkSession => {
    const session: ParentWalkSession = Object.freeze({
      kind: "shared",
      route: admittedRoute.route,
      selectedTarget: params.resolvedTargetPath,
      nativeMode: getFsSafeNativeConfig().mode,
      rootIdentity: admittedRoute.rootIdentity,
      authorizationToken: Object.freeze({}),
    });
    let disposed = false;
    let disabled = false;
    let sharedEpoch: Epoch | undefined;
    let sharedPending: CreateReceipt | undefined;
    const disable = () => {
      disabled = true;
      sharedEpoch = undefined;
      sharedPending = undefined;
    };
    return Object.freeze({
      retainedTargetPath: session.route,
      tryAuthorizeAtParent(request, parent) {
        if (disposed || disabled) return undefined;
        // The walk's first missing component has no receipt epoch yet. Treat
        // that as an ordinary cache miss so authorize() can bracket the full
        // ordered admission and seed this session.
        if (!sharedEpoch && !sharedPending) return undefined;
        // A receipt must be consumed by the exact mkdir/advance pair before
        // another parent-bound authorization can be attempted.
        if (sharedPending) {
          disable();
          return undefined;
        }
        const reusable = sharedEpoch;
        if (!reusable || reusable.session !== session ||
          !reusableSharedCreateRequest(request, reusable) ||
          !mutationObservationUsesDirectory(reusable.target, parent) ||
          !nonzeroDirectoryObservation(parent) || !epochCurrent(reusable, [parent])) {
          disable();
          return undefined;
        }
        assertCachedNotDenied(request.targetPath, reusable);
        assertCachedNotDenied(request.mutationPath, reusable);
        // The epoch check ends with the exact parent fence. The receipt is
        // consumed synchronously before any intervening authority callback.
        sharedPending = Object.freeze({
          epoch: reusable,
          childPath: request.mutationPath,
          session,
        });
        return sharedPending;
      },
      async authorize(request) {
        // A create receipt reaching a full before-use admission means mkdir
        // did not yield owned, complete post-create evidence (including
        // EEXIST). The rest of this walk stays on ordered admission.
        if (sharedPending) disable();
        const reusable = sharedEpoch;
        if (!disposed && !disabled && reusable?.session === session &&
          reusableSharedRequest(request, reusable) && epochCurrent(reusable)) {
          assertCachedNotDenied(request.targetPath, reusable);
          assertCachedNotDenied(request.mutationPath, reusable);
          return undefined;
        }
        if (reusable) disable();
        const captureRequested = !disposed && !disabled &&
          request.targetPath === session.route;
        const candidate = captureRequested
          ? captureEpoch(params.rootReal, session.route, policy, session)
          : undefined;
        if (captureRequested &&
          (!candidate || !reusableSharedRequest(request, candidate))) disable();
        const current = await authorizeFully(request);
        if (disposed || disabled || !candidate) {
          sharedEpoch = undefined;
          return undefined;
        }
        if (current.resolved !== session.route ||
          current.resolved !== session.selectedTarget || !epochCurrent(candidate)) {
          disable();
          return undefined;
        }
        // Observations bracket the ordered admission. Never attach a receipt
        // to evidence collected only after the policy decisions it replaces.
        sharedEpoch = candidate;
        if (request.phase === "parent") return undefined;
        sharedPending = Object.freeze({
          epoch: candidate,
          childPath: request.mutationPath,
          session,
        });
        return sharedPending;
      },
      advanceCreatedDirectory(receipt) {
        const admitted = sharedPending;
        const admittedEpoch = sharedEpoch;
        sharedPending = undefined;
        sharedEpoch = undefined;
        if (disposed || disabled || admittedEpoch?.session !== session) {
          disable();
          return undefined;
        }
        const next = advanceAuthorizedDirectory(admittedEpoch, admitted, receipt);
        if (!next) {
          disable();
          return undefined;
        }
        sharedEpoch = next;
        return session.authorizationToken;
      },
      dispose() {
        disposed = true;
        disable();
      },
    });
  };
  const mutationAdmission: PinnedWriteMutationAdmission = Object.freeze({
    rejectParentSymlinks: policy.mutationSymlinks === "reject",
    beginParentWalk: route ? () => {
      pinnedSession = Object.freeze({
        kind: "pinned",
        route,
        selectedTarget: params.resolvedTargetPath,
        nativeMode: getFsSafeNativeConfig().mode,
        authorizationToken: Object.freeze({}),
      });
      epoch = undefined;
      pending = undefined;
      return route;
    } : undefined,
    beginSharedParentWalk: sharedRoute ? () => createSharedParentWalk(sharedRoute) : undefined,
    beginNativeParentWalk: nativeRoute ? () => createSharedParentWalk(nativeRoute) : undefined,
    tryAuthorizeAtParent(request, parent) {
      pending = undefined;
      const reusable = epoch;
      if (!reusable || reusable.session !== pinnedSession ||
        !reusableRequest(request, reusable) ||
        !mutationObservationUsesDirectory(reusable.target, parent) ||
        !epochCurrent(reusable, [parent])) {
        epoch = undefined;
        return undefined;
      }
      assertCachedNotDenied(request.targetPath, reusable);
      assertCachedNotDenied(request.mutationPath, reusable);
      // The epoch check ends at the exact parent pathname, canonical spelling,
      // identity, type, mode and link-count fence, with no intervening await.
      if (request.phase === "parent-create") {
        pending = Object.freeze({
          epoch: reusable,
          childPath: request.mutationPath,
          session: reusable.session,
        });
        return pending;
      }
      return reusable.session.authorizationToken;
    },
    async authorize(request) {
      pending = undefined;
      if (epoch && epoch.session === pinnedSession &&
        reusableRequest(request, epoch) && epochCurrent(epoch)) {
        assertCachedNotDenied(request.targetPath, epoch);
        assertCachedNotDenied(request.mutationPath, epoch);
        if (request.phase === "parent-create") {
          pending = Object.freeze({
            epoch,
            childPath: request.mutationPath,
            session: epoch.session,
          });
          return pending;
        }
        return undefined;
      }
      epoch = undefined;
      const session = pinnedSession;
      const candidate = session && route === request.targetPath
        ? captureEpoch(params.rootReal, route, policy, session) : undefined;
      const current = await authorizeFully(request);
      // Observations bracket the ordered admission. Never attach a cache to
      // evidence collected only after the policy decisions it would replace.
      if (candidate && candidate.session === pinnedSession &&
        current.resolved === route && epochCurrent(candidate)) {
        epoch = candidate;
        if (request.phase === "parent-create" && reusableRequest(request, candidate)) {
          pending = Object.freeze({
            epoch: candidate,
            childPath: request.mutationPath,
            session: candidate.session,
          });
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
      const next = advanceAuthorizedDirectory(admittedEpoch, admitted, receipt);
      if (!next) return undefined;
      epoch = next;
      return next.session.authorizationToken;
    } : undefined,
  });
  return {
    relativeParentPath: relativeCanonicalParent
      ? relativeCanonicalParent.split(path.sep).join(path.posix.sep)
      : "",
    mutationAdmission,
  };
}
