import path from "node:path";
import type { DenyMutationPolicy } from "./deny-mutations.js";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./device-path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import type { RootBoundaryIdentity } from "./root-boundary.js";
import { isSafePathSegment } from "./safe-path-segment.js";
import type { MutationSymlinkPolicy } from "./root-symlink-policy.js";

export type ExactRootIdentity = Readonly<{ dev: bigint; ino: bigint }>;

type SharedMutationPolicy = Readonly<{
  denyMutations?: DenyMutationPolicy;
  mutationSymlinks?: MutationSymlinkPolicy;
}>;

function windowsReservedDeviceSegment(segment: string): boolean {
  const extension = segment.indexOf(".");
  const stem = segment.slice(0, extension < 0 ? segment.length : extension).toUpperCase();
  return WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
}

function ordinaryWindowsSegments(relativePath: string): boolean {
  if (relativePath === "" || relativePath.includes("/") || relativePath.includes("\0")) return false;
  const segments = relativePath.split("\\");
  return segments.every((segment) => isSafePathSegment(segment, { allowDotPrefix: true }) &&
    !segment.endsWith(".") && !segment.endsWith(" ") &&
    !windowsReservedDeviceSegment(segment));
}

function exactNonzeroRootIdentity(
  identity: RootBoundaryIdentity | undefined,
): ExactRootIdentity | undefined {
  return typeof identity?.dev === "bigint" && typeof identity.ino === "bigint" &&
    identity.dev !== 0n && identity.ino !== 0n
    ? Object.freeze({ dev: identity.dev, ino: identity.ino })
    : undefined;
}

export function ordinaryWindowsAbsoluteInsideRoot(
  rootReal: string,
  candidatePath: string,
  rootIdentity: ExactRootIdentity,
): boolean {
  if (!path.isAbsolute(candidatePath) || candidatePath.startsWith("\\\\") ||
    candidatePath.includes("/") || candidatePath.includes("\0") ||
    path.resolve(candidatePath) !== candidatePath) return false;
  const admitted = admitPathInsideRoot({
    rootPath: rootReal,
    candidatePath,
    rootIdentity,
  });
  return admitted?.admission === "exact" && admitted.path === candidatePath &&
    (admitted.relativePath === "" || ordinaryWindowsSegments(admitted.relativePath));
}

export function simpleSharedRoute(params: {
  rootReal: string;
  rootIdentity?: RootBoundaryIdentity;
  originalPath?: string;
  selectedTarget: string;
  policy: SharedMutationPolicy;
}): { route: string; rootIdentity: ExactRootIdentity } | undefined {
  if (process.platform !== "win32" || process.versions.bun ||
    params.policy.mutationSymlinks !== "reject" || !params.originalPath ||
    params.originalPath.startsWith("~") || path.isAbsolute(params.originalPath) ||
    !ordinaryWindowsSegments(params.originalPath) || params.rootReal.startsWith("\\\\") ||
    params.rootReal.includes("/") || path.resolve(params.rootReal) !== params.rootReal) return undefined;
  const rootIdentity = exactNonzeroRootIdentity(params.rootIdentity);
  if (!rootIdentity) return undefined;
  const route = path.resolve(params.rootReal, params.originalPath);
  if (route !== params.selectedTarget ||
    !ordinaryWindowsAbsoluteInsideRoot(params.rootReal, route, rootIdentity)) return undefined;
  const policyEntries = [
    ...(params.policy.denyMutations?.paths ?? []),
    ...(params.policy.denyMutations?.prefixes ?? []),
  ];
  if (policyEntries.some((entry) => entry !== path.resolve(entry) ||
    !ordinaryWindowsAbsoluteInsideRoot(params.rootReal, entry, rootIdentity))) return undefined;
  return { route, rootIdentity };
}
