import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { PATH_ALIAS_POLICIES } from "./path-policy.js";
import {
  RootPathObservationError,
  resolveRootPathWithObservation,
  type RootPathObservationKind,
  type RootPathObservationReceipt,
} from "./root-path.js";
import {
  createRootObservationGuard,
  ensureTrailingSep,
  expandRelativePathWithHome,
  type RootContext,
} from "./root-context.js";
import { fileNotFoundError, outsideWorkspaceError } from "./root-errors.js";

export type PinnedObservedPath = {
  rootReal: string;
  resolved: string;
  relativePosix: string;
  receipt?: RootPathObservationReceipt;
};

export async function resolvePinnedObservedPathInRoot(
  root: RootContext,
  relativePath: string,
  kind: RootPathObservationKind,
): Promise<PinnedObservedPath | undefined> {
  const rootGuard = await createRootObservationGuard(root);
  if (!rootGuard) return undefined;
  const rootReal = root.rootReal;
  let observed: Awaited<ReturnType<typeof resolveRootPathWithObservation>>;
  try {
    const expandedPath = await expandRelativePathWithHome(relativePath);
    observed = await resolveRootPathWithObservation({
      absolutePath: path.isAbsolute(expandedPath)
        ? expandedPath
        : `${ensureTrailingSep(rootReal)}${expandedPath}`,
      rootPath: rootReal,
      rootCanonicalPath: rootReal,
      boundaryLabel: "root",
      policy: PATH_ALIAS_POLICIES.strict,
    }, { kind, rootGuard });
  } catch (error) {
    if (error instanceof RootPathObservationError) {
      if (isNotFoundPathError(error.error)) {
        if (kind === "stat") {
          throw fileNotFoundError(error.error instanceof Error ? error.error : undefined);
        }
        throw new FsSafeError("not-found", "directory not found", {
          cause: error.error instanceof Error ? error.error : undefined,
        });
      }
      throw error.error;
    }
    if (error instanceof FsSafeError && error.code === "symlink") throw error;
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: error });
  }
  const resolved = observed.resolved;
  const relativeResolved = path.relative(resolved.rootCanonicalPath, resolved.canonicalPath);
  if (relativeResolved === "" || relativeResolved === ".") {
    return {
      rootReal: resolved.rootCanonicalPath,
      resolved: resolved.canonicalPath,
      relativePosix: "",
      ...(observed.receipt ? { receipt: observed.receipt } : {}),
    };
  }
  const firstSegment = relativeResolved.split(path.sep)[0];
  if (firstSegment === ".." || path.isAbsolute(relativeResolved) ||
    !isPathInside(ensureTrailingSep(resolved.rootCanonicalPath), resolved.canonicalPath)) {
    throw outsideWorkspaceError();
  }
  return {
    rootReal: resolved.rootCanonicalPath,
    resolved: resolved.canonicalPath,
    relativePosix: relativeResolved.split(path.sep).join(path.posix.sep),
    ...(observed.receipt ? { receipt: observed.receipt } : {}),
  };
}
