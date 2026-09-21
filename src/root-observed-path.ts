import path from "node:path";
import { FsSafeError } from "./errors.js";
import { getNativeDirectoryObservationBackend } from "./native-directory-observation.js";
import { isNotFoundPathError } from "./path.js";
import { PATH_ALIAS_POLICIES } from "./path-policy.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootPathObservationReceiptCurrent } from "./root-directory-list.js";
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
import { errorCauseOptions, fileNotFoundError, outsideWorkspaceError } from "./root-errors.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export type PinnedObservedPath = {
  rootReal: string;
  resolved: string;
  receipt?: RootPathObservationReceipt;
};

export async function resolvePinnedObservedPathInRoot(
  root: RootContext,
  relativePath: string,
  kind: RootPathObservationKind,
): Promise<PinnedObservedPath | undefined> {
  const rootGuard = await createRootObservationGuard(root);
  if (!rootGuard) return undefined;
  // Race hooks exercise the established JavaScript observation points. Do not
  // silently move those points into the native helper in test configurations.
  const directoryObserver = getNativeDirectoryObservationBackend(
    getFsSafeTestHooks() === undefined,
  );
  const rootReal = root.rootReal;
  let observed: Awaited<ReturnType<typeof resolveRootPathWithObservation>>;
  try {
    const expandedPath = await expandRelativePathWithHome(relativePath);
    const observationPath = process.platform === "win32"
      ? expandedPath.replaceAll("/", path.sep)
      : expandedPath;
    observed = await resolveRootPathWithObservation({
      absolutePath: path.isAbsolute(observationPath)
        ? observationPath
        : observationPath === ""
          ? rootReal
          : `${ensureTrailingSep(rootReal)}${observationPath}`,
      rootPath: rootReal,
      rootCanonicalPath: rootReal,
      rootIdentity: root.rootIdentity,
      boundaryLabel: "root",
      policy: PATH_ALIAS_POLICIES.strict,
    }, { kind, rootGuard, directoryObserver });
  } catch (error) {
    if (error instanceof RootPathObservationError) {
      if (error.parentReceipt) {
        assertRootPathObservationReceiptCurrent(root, error.parentReceipt);
        if (error.traversalFailure && !isNotFoundPathError(error.error)) {
          if (error.error instanceof FsSafeError && error.error.code === "symlink") throw error.error;
          throw new FsSafeError("path-alias", "path alias escape blocked", { cause: error.error });
        }
      }
      if (isNotFoundPathError(error.error)) {
        if (kind === "stat") {
          throw fileNotFoundError(error.error instanceof Error ? error.error : undefined);
        }
        throw new FsSafeError("not-found", "directory not found", errorCauseOptions(error.error));
      }
      throw error.error;
    }
    if (error instanceof FsSafeError && error.code === "symlink") throw error;
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: error });
  }
  const resolved = observed.resolved;
  if (observed.receipt) {
    // A receipt is emitted only for the straight traversal whose lexical and
    // canonical cursors stayed identical and inside the checked boundary.
    return {
      rootReal: resolved.rootCanonicalPath,
      resolved: resolved.canonicalPath,
      receipt: observed.receipt,
    };
  }
  const relativeResolved = path.relative(resolved.rootCanonicalPath, resolved.canonicalPath);
  if (relativeResolved === "" || relativeResolved === ".") {
    return {
      rootReal: resolved.rootCanonicalPath,
      resolved: resolved.canonicalPath,
    };
  }
  const firstSegment = relativeResolved.split(path.sep)[0];
  if (firstSegment === ".." || path.isAbsolute(relativeResolved)) {
    throw outsideWorkspaceError();
  }
  const admittedCanonicalPath = admitPathInsideRoot({
    rootPath: resolved.rootCanonicalPath,
    candidatePath: resolved.canonicalPath,
    rootIdentity: root.rootIdentity,
  });
  if (!admittedCanonicalPath) throw outsideWorkspaceError();
  return {
    rootReal: resolved.rootCanonicalPath,
    resolved: admittedCanonicalPath.path,
  };
}
