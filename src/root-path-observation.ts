import fs, { type BigIntStats } from "node:fs";
import {
  extendDirectoryObservationGuard,
  type DirectoryObservationGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import {
  extendNativeDirectoryObservationGuard,
  inspectNativeDirectoryObservation,
  isNativeDirectoryObservationGuard,
  type NativeDirectoryObservationBackend,
  type NativeDirectoryObservationGuard,
} from "./native-directory-observation.js";
import {
  admitPathInsideRoot,
  type RootBoundaryIdentity,
} from "./root-boundary.js";
import { realpathSync } from "./realpath.js";
import { inspectStatObservationSync, type StatObservationReceipt } from "./stat-observation.js";

export type RootPathObservationKind = "stat" | "directory";

export type RootPathDirectoryObservationGuard =
  | DirectoryObservationGuard
  | NativeDirectoryObservationGuard;

export type RootPathTargetObservation =
  | StatObservationReceipt
  | NativeDirectoryObservationGuard;

/** An exact receipt owned by one stat/list operation. Never cache it. */
export type RootPathObservationReceipt = {
  kind: RootPathObservationKind;
  rootGuard: DirectoryObservationGuard;
  directoryGuard: RootPathDirectoryObservationGuard;
  directoryObserver?: NativeDirectoryObservationBackend;
  targetPath: string;
  target: RootPathTargetObservation;
};

export type RootPathObservationRequest = {
  kind: RootPathObservationKind;
  rootGuard: DirectoryObservationGuard;
  directoryObserver?: NativeDirectoryObservationBackend;
};

export type RootPathTraversalObservation = {
  enabled: boolean;
  request: RootPathObservationRequest;
  targetIndex: number;
  directoryIndex: number;
  directoryGuard?: RootPathDirectoryObservationGuard;
  directoryObserver?: NativeDirectoryObservationBackend;
  targetPath?: string;
  target?: RootPathTargetObservation;
};

export type RootPathObservedTraversalEntry =
  | { stat: fs.Stats | BigIntStats; identity?: StatObservationReceipt["identity"] }
  | NativeDirectoryObservationGuard;

// Observation-only failures happen after ordinary traversal has admitted the
// name. Keep them distinguishable so Root preserves existing error precedence.
export class RootPathObservationError extends Error {
  constructor(readonly error: unknown) {
    super("root path observation failed", { cause: error });
    this.name = "RootPathObservationError";
  }
}

function straightTraversalPath(value: string): boolean {
  if (value.length === 0) return false;
  const windows = process.platform === "win32";
  let segmentStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const separator = index === value.length || value[index] === "/" ||
      (windows && value[index] === "\\");
    if (!separator) continue;
    const segmentLength = index - segmentStart;
    if (segmentLength === 0 ||
      (segmentLength === 1 && value.charCodeAt(segmentStart) === 0x2e) ||
      (segmentLength === 2 && value.charCodeAt(segmentStart) === 0x2e &&
        value.charCodeAt(segmentStart + 1) === 0x2e)) return false;
    segmentStart = index + 1;
  }
  return true;
}

export type RootPathTraversalContext = {
  observationEligible: boolean;
  rootPath: string;
  rootCanonicalPath: string;
  resolveParams: { rootIdentity?: RootBoundaryIdentity };
  state: {
    finalComponentIndex: number;
    relativePath: string;
    segments: string[];
  };
};

export function createRootPathTraversalObservation(
  context: RootPathTraversalContext,
  request?: RootPathObservationRequest,
): RootPathTraversalObservation | undefined {
  const { state } = context;
  const rootTraversal = state.finalComponentIndex < 0 &&
    (state.relativePath === "" || state.relativePath === ".");
  if (!request || !context.observationEligible ||
    request.rootGuard.dir !== context.rootCanonicalPath ||
    request.rootGuard.realPath !== context.rootCanonicalPath ||
    context.rootPath !== context.rootCanonicalPath ||
    (!rootTraversal && !straightTraversalPath(state.relativePath)) ||
    (!rootTraversal && state.finalComponentIndex !== state.segments.length - 1)) return undefined;
  if (state.finalComponentIndex >= 0) {
    const directoryIndex = request.kind === "stat"
      ? state.finalComponentIndex - 1
      : state.finalComponentIndex;
    return {
      enabled: true,
      request,
      targetIndex: state.finalComponentIndex,
      directoryIndex,
      directoryGuard: directoryIndex < 0 ? request.rootGuard : undefined,
      // A direct-child stat has no selected-directory slot at which the
      // optional helper can establish a receipt. Keep its final Root fence on
      // the established JavaScript path so helper unavailability cannot first
      // appear after the target has been admitted.
      directoryObserver: directoryIndex < 0 ? undefined : request.directoryObserver,
    };
  }
  if (!rootTraversal) return undefined;
  let directoryGuard: RootPathDirectoryObservationGuard = request.rootGuard;
  // Root-only stat likewise has no pre-admission helper observation. Root
  // listing below does establish one and may safely retain the backend.
  let directoryObserver = request.kind === "stat" ? undefined : request.directoryObserver;
  if (request.kind === "directory") {
    if (directoryObserver) {
      try {
        const observed = inspectNativeDirectoryObservation(
          directoryObserver,
          request.rootGuard.dir,
          request.rootGuard.identity,
        );
        const admitted = admitPathInsideRoot({
          rootPath: context.rootCanonicalPath,
          candidatePath: observed.realPath,
          rootIdentity: context.resolveParams.rootIdentity,
        });
        if (!admitted || admitted.relativePath !== "") {
          throw new FsSafeError("path-mismatch", "root path changed during operation");
        }
        observed.realPath = admitted.path;
        directoryGuard = extendNativeDirectoryObservationGuard(observed, request.rootGuard.dir);
      } catch (error) {
        if (error instanceof FsSafeError && error.code === "path-mismatch") {
          throw new RootPathObservationError(error);
        }
        directoryObserver = undefined;
      }
    }
    if (!directoryObserver) {
      try {
        const admitted = admitPathInsideRoot({
          rootPath: context.rootCanonicalPath,
          candidatePath: realpathSync.native(request.rootGuard.dir),
          rootIdentity: context.resolveParams.rootIdentity,
        });
        if (!admitted || admitted.relativePath !== "") {
          throw new FsSafeError("path-mismatch", "root path changed during operation");
        }
      } catch (error) {
        throw new RootPathObservationError(error);
      }
    }
  }
  return {
    enabled: true,
    request,
    targetIndex: -1,
    directoryIndex: -1,
    directoryGuard,
    directoryObserver,
    targetPath: context.rootCanonicalPath,
    target: directoryGuard,
  };
}

export function inspectRootPathTraversalEntry(
  pathname: string,
  directorySlot: boolean,
  observation: RootPathTraversalObservation,
): RootPathObservedTraversalEntry {
  if (directorySlot && observation.directoryObserver) {
    try {
      return extendNativeDirectoryObservationGuard(
        inspectNativeDirectoryObservation(observation.directoryObserver, pathname),
        pathname,
      );
    } catch {
      // This directory has not been admitted yet. Preserve the established
      // resolver and error ordering when the optional observation is unusable.
      observation.directoryObserver = undefined;
    }
  }
  const first = process.platform === "win32"
    ? fs.lstatSync(pathname, { bigint: true }) : fs.lstatSync(pathname);
  if (first.isSymbolicLink() || (directorySlot && !first.isDirectory())) return { stat: first };
  try {
    return inspectStatObservationSync(bigint => bigint
      ? fs.lstatSync(pathname, { bigint: true }) : fs.lstatSync(pathname), undefined, first);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch") {
      throw new RootPathObservationError(error);
    }
    throw error;
  }
}

export function captureRootPathObservedDirectory(
  observation: RootPathTraversalObservation,
  observed: RootPathObservedTraversalEntry,
  publicPath: string,
  canonicalPath: string,
  rootCanonicalPath: string,
  rootIdentity?: RootBoundaryIdentity,
): boolean {
  if (!isNativeDirectoryObservationGuard(observed) && !observed.stat.isDirectory()) return false;
  let realPath: string;
  try {
    realPath = isNativeDirectoryObservationGuard(observed)
      ? observed.realPath
      : realpathSync.native(canonicalPath);
  } catch (error) {
    throw new RootPathObservationError(error);
  }
  const admitted = admitPathInsideRoot({
    rootPath: rootCanonicalPath,
    candidatePath: realPath,
    rootIdentity,
  });
  if (!admitted) {
    throw new RootPathObservationError(
      new FsSafeError("outside-workspace", "directory is outside workspace root"),
    );
  }
  if (isNativeDirectoryObservationGuard(observed)) {
    observed.dir = publicPath;
    observed.realPath = admitted.path;
    observation.directoryGuard = observed;
  } else {
    observation.directoryGuard = extendDirectoryObservationGuard(
      observed as StatObservationReceipt,
      publicPath,
      admitted.path,
    );
  }
  return true;
}
