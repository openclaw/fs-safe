import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { shortPath } from "./error-detail.js";
import { pathEscapeError, sanitizeRootPathError, symlinkEscapeError } from "./root-path-errors.js";
import { FsSafeError } from "./errors.js";
import { isNativeDirectoryObservationGuard } from "./native-directory-observation.js";
import {
  assertNoNulPathInput,
  isNotFoundPathError,
  isPathRelativeEscape,
} from "./path.js";
import {
  absolutePathWithRawSegments,
  rawPathRelativeToCanonicalRoot,
  resolveExistingAncestor,
  resolveSymlinkHopPath,
  type RootPathMetadataMode,
} from "./root-path-existing.js";
import {
  admitPathInsideRoot,
  type AdmittedRootPath,
  type RootBoundaryIdentity,
} from "./root-boundary.js";
import {
  RootPathObservationError,
  captureRootPathObservedDirectory,
  createRootPathTraversalObservation,
  inspectRootPathTraversalEntry,
  type RootPathObservationReceipt,
  type RootPathParentObservationReceipt,
  type RootPathObservationRequest,
  type RootPathTraversalObservation,
} from "./root-path-observation.js";
import { assertNoDriveRelativePathSegments } from "./safe-path-segment.js";
import type { RemovalPathReceipts } from "./root-remove-receipt.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export { resolvePathViaExistingAncestorSync } from "./root-path-existing.js";
export {
  RootPathObservationError,
  type RootPathDirectoryObservationGuard,
  type RootPathObservationKind,
  type RootPathObservationReceipt,
  type RootPathParentObservationReceipt,
  type RootPathObservationRequest,
  type RootPathTargetObservation,
} from "./root-path-observation.js";

type RootPathIntent = "read" | "write" | "create" | "delete" | "stat";

export type RootPathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};

export const ROOT_PATH_ALIAS_POLICIES = {
  strict: Object.freeze({
    allowFinalSymlinkForUnlink: false,
    allowFinalHardlinkForUnlink: false,
  }),
  unlinkTarget: Object.freeze({
    allowFinalSymlinkForUnlink: true,
    allowFinalHardlinkForUnlink: true,
  }),
} as const;

type ResolveRootPathParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  intent?: RootPathIntent;
  policy?: RootPathAliasPolicy;
  rejectSymlinks?: boolean;
  rejectFinalSymlink?: boolean;
  rejectUnresolvedSymlinks?: boolean;
  skipLexicalRootCheck?: boolean;
  rootCanonicalPath?: string;
  rootIdentity?: RootBoundaryIdentity;
};

type ResolvedRootPathKind = "missing" | "file" | "directory" | "symlink" | "other";

export type ResolvedRootPath = {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  relativePath: string;
  exists: boolean;
  kind: ResolvedRootPathKind;
};

export type ObservedRootPath = {
  resolved: ResolvedRootPath;
  receipt?: RootPathObservationReceipt;
};

export async function resolveRootPath(
  params: ResolveRootPathParams,
): Promise<ResolvedRootPath> {
  return resolveRootPathInternal(params);
}

export async function resolveRootPathWithCanonicalRootObservation(
  params: ResolveRootPathParams,
  observeRoot: (rootCanonicalPath: string) => void,
): Promise<ResolvedRootPath> {
  return resolveRootPathInternal(params, { observeRoot });
}

export async function resolveRootPathWithObservation(
  params: ResolveRootPathParams,
  request: RootPathObservationRequest,
): Promise<ObservedRootPath> {
  const observation: RootPathObservationOutput = { request };
  const resolved = resolveRootPathInternal(params, { observation });
  return observation.receipt ? { resolved, receipt: observation.receipt } : { resolved };
}

// Removal receipts are separate from metadata observations and canonical-root
// callbacks; the public resolver's options and result remain unchanged.
export async function resolveRootPathForRemoval(
  params: ResolveRootPathParams,
  receipts: RemovalPathReceipts,
): Promise<ResolvedRootPath> {
  return resolveRootPathInternal(params, { removalReceipts: receipts });
}

export function resolveRootPathSync(params: ResolveRootPathParams): ResolvedRootPath {
  return resolveRootPathInternal(params, { mode: "ordinary" });
}

export function resolveRootPathSyncWithCanonicalRootObservation(
  params: ResolveRootPathParams,
  observeRoot: (rootCanonicalPath: string) => void,
): ResolvedRootPath {
  return resolveRootPathInternal(params, { mode: "ordinary", observeRoot });
}

type RootPathObservationOutput = {
  request: RootPathObservationRequest;
  receipt?: RootPathObservationReceipt;
};

type RootPathTraversalOptions = {
  mode?: RootPathMetadataMode;
  observation?: RootPathObservationOutput;
  observeRoot?: (rootCanonicalPath: string) => void;
  removalReceipts?: RemovalPathReceipts;
};

function resolveRootPathInternal(
  params: ResolveRootPathParams,
  options: RootPathTraversalOptions = {},
): ResolvedRootPath {
  try {
    return traverseRootPath(params, options);
  } catch (error) {
    throw sanitizeRootPathError(error);
  }
}

function prepareRootTraversal(
  params: ResolveRootPathParams,
  rootPath: string,
  rootCanonicalPath: string,
  absolutePath: string,
  rawAbsolutePath: string,
): LexicalResolutionParams {
  let raw = rawAbsolutePath;
  let trustedAbsolutePath = false;
  const direct = admitRawPathInsideRoot(rootPath, raw, params.rootIdentity);
  if (direct) {
    raw = direct.path;
    trustedAbsolutePath = direct.admission === "identity";
  } else {
    const canonical = admitRawPathInsideRoot(rootCanonicalPath, raw, params.rootIdentity);
    const relative = canonical?.relativePath
      ?? rawPathRelativeToCanonicalRoot(raw, rootCanonicalPath, params);
    if (relative === undefined) {
      throw pathEscapeError({ rootPath, absolutePath: raw, boundaryLabel: params.boundaryLabel });
    }
    trustedAbsolutePath = canonical?.admission === "identity";
    raw = relative === "" ? rootPath : `${rootPath}${path.sep}${relative}`;
  }
  return {
    params,
    rawAbsolutePath: raw,
    rootPath,
    rootCanonicalPath,
    // Preserve the caller-spelling receipt for ordinary aliases. Only a
    // Windows case-fold admission must return the identity-gated Root spelling,
    // because downstream I/O must not reuse the ambiguous caller prefix.
    absolutePath: trustedAbsolutePath ? resolvePathPreservingWindowsRoot(raw) : absolutePath,
    observationEligible: raw === rawAbsolutePath && !trustedAbsolutePath,
  };
}

function captureValidRootPathInputs(params: ResolveRootPathParams): ResolveRootPathParams {
  const rootPath = params.rootPath;
  assertNoNulPathInput(rootPath, "root path contains a NUL byte");
  const absolutePath = params.absolutePath;
  assertNoNulPathInput(absolutePath, "absolute path contains a NUL byte");
  assertNoWindowsPathAlias(rootPath, "filesystem", "root path uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(absolutePath, "filesystem", "absolute path uses a Windows filesystem namespace alias");
  assertNoEmbeddedDriveRelativeSegment(rootPath, "root path");
  assertNoEmbeddedDriveRelativeSegment(absolutePath, "absolute path");
  const rootCanonicalPath = params.rootCanonicalPath;
  if (rootCanonicalPath !== undefined) {
    assertNoNulPathInput(rootCanonicalPath, "canonical root path contains a NUL byte");
    assertNoWindowsPathAlias(
      rootCanonicalPath,
      "filesystem",
      "canonical root path uses a Windows filesystem namespace alias",
    );
    assertNoEmbeddedDriveRelativeSegment(rootCanonicalPath, "canonical root path");
  }
  // Keep traversal policy with the admitted paths across ancestor and symlink
  // resolution. Caller-owned flags and getters must not change a running walk.
  const policy = params.policy;
  const rootIdentity = params.rootIdentity;
  return {
    rootPath,
    absolutePath,
    rootCanonicalPath,
    rootIdentity: rootIdentity == null ? undefined : { dev: rootIdentity.dev, ino: rootIdentity.ino },
    boundaryLabel: params.boundaryLabel,
    policy: policy == null ? undefined : {
      allowFinalSymlinkForUnlink: policy.allowFinalSymlinkForUnlink,
    },
    rejectSymlinks: params.rejectSymlinks,
    rejectFinalSymlink: params.rejectFinalSymlink,
    rejectUnresolvedSymlinks: params.rejectUnresolvedSymlinks,
  };
}

function assertNoEmbeddedDriveRelativeSegment(filePath: string, label: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const root = path.parse(filePath).root;
  assertNoDriveRelativePathSegments(
    filePath.slice(root.length).replaceAll("\\", "/"),
    label,
  );
}

type LexicalTraversalContext = {
  state: {
    segments: string[];
    relativePath: string;
    reuseLexicalCanonical: boolean;
    finalComponentIndex: number;
    allowFinalSymlink: boolean;
    canonicalCursor: string;
    lexicalCursor: string;
    preserveFinalSymlink: boolean;
    missingDepth: number;
  };
  resolveParams: ResolveRootPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
  observationEligible: boolean;
};

function createLexicalTraversalContext(params: LexicalResolutionParams): LexicalTraversalContext {
  const relative = admitRawPathInsideRoot(
    params.rootPath,
    params.rawAbsolutePath,
    params.params.rootIdentity,
  )?.relativePath;
  if (relative === undefined) throw new Error("Path traversal must begin at the root");
  const segments = splitTraversalSegments(relative);
  return {
    state: {
      segments,
      relativePath: relative,
      reuseLexicalCanonical: false,
      finalComponentIndex: segments.findLastIndex((segment) => segment !== "."),
      allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
      canonicalCursor: params.rootCanonicalPath,
      lexicalCursor: params.rootPath,
      preserveFinalSymlink: false,
      missingDepth: 0,
    },
    resolveParams: params.params,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    absolutePath: params.absolutePath,
    observationEligible: params.observationEligible,
  };
}

function createLexicalTraversalObservation(
  context: LexicalTraversalContext,
  request: RootPathObservationRequest | undefined,
): RootPathTraversalObservation | undefined {
  const observation = createRootPathTraversalObservation(context, request);
  if (observation && observation.targetIndex >= 0) {
    context.state.reuseLexicalCanonical = true;
  }
  return observation;
}

function splitTraversalSegments(value: string): string[] {
  const segments = value
    .split(process.platform === "win32" ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  if (value.endsWith("/") || (process.platform === "win32" && value.endsWith("\\"))) segments.push(".");
  return segments;
}

function admitRawPathInsideRoot(
  rootPath: string,
  candidatePath: string,
  rootIdentity?: RootBoundaryIdentity,
): AdmittedRootPath | undefined {
  if (!path.isAbsolute(candidatePath)) {
    return undefined;
  }
  // Every caller supplies the already-resolved root selected by
  // resolveRootPathInternal; resolving it again is redundant on each traversal.
  const root = rootPath;
  const candidate = process.platform === "win32"
    ? candidatePath.replaceAll("/", path.sep)
    : candidatePath;
  if (process.platform === "win32") {
    return admitPathInsideRoot({ rootPath: root, candidatePath: candidate, rootIdentity });
  }
  if (candidate === root) {
    return { admission: "exact", path: candidate, relativePath: "" };
  }
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const candidatePrefix = candidate.slice(0, rootWithSep.length);
  return candidatePrefix === rootWithSep
    ? {
      admission: "exact",
      path: candidate,
      relativePath: candidate.slice(rootWithSep.length),
    }
    : undefined;
}

function assertLexicalCursorInsideBoundary(
  context: LexicalTraversalContext,
  candidatePath: string,
): string {
  return assertInsideBoundary({
    boundaryLabel: context.resolveParams.boundaryLabel,
    rootCanonicalPath: context.rootCanonicalPath,
    rootIdentity: context.resolveParams.rootIdentity,
    candidatePath,
    absolutePath: context.absolutePath,
  });
}

function advanceCanonicalCursorForSegment(
  context: LexicalTraversalContext,
  segment: string,
): void {
  const candidatePath = context.state.reuseLexicalCanonical
    ? context.state.lexicalCursor
    : resolvePathFromBasePreservingWindowsRoot(context.state.canonicalCursor, segment);
  context.state.canonicalCursor = assertLexicalCursorInsideBoundary(
    context,
    candidatePath,
  );
}

function disableLexicalTraversalObservation(
  context: LexicalTraversalContext,
  observation: RootPathTraversalObservation,
): void {
  observation.enabled = false;
  context.state.reuseLexicalCanonical = false;
}

function finalizeLexicalResolution(
  context: LexicalTraversalContext,
  kind: { exists: boolean; kind: ResolvedRootPathKind },
): ResolvedRootPath {
  context.state.canonicalCursor = assertLexicalCursorInsideBoundary(
    context,
    context.state.canonicalCursor,
  );
  return {
    absolutePath: context.absolutePath,
    canonicalPath: context.state.canonicalCursor,
    rootPath: context.rootPath,
    rootCanonicalPath: context.rootCanonicalPath,
    relativePath: relativeInsideRoot(context.rootCanonicalPath, context.state.canonicalCursor),
    exists: kind.exists,
    kind: kind.kind,
  };
}

function applyResolvedSymlinkHop(
  context: LexicalTraversalContext,
  linkCanonical: string,
): void {
  let admitted: string;
  try {
    admitted = assertLexicalCursorInsideBoundary(context, linkCanonical);
  } catch {
    throw symlinkEscapeError({
      boundaryLabel: context.resolveParams.boundaryLabel,
      rootCanonicalPath: context.rootCanonicalPath,
      symlinkPath: context.state.lexicalCursor,
    });
  }
  context.state.canonicalCursor = admitted;
  context.state.lexicalCursor = admitted;
}

function applyParentTraversalStep(context: LexicalTraversalContext): void {
  context.state.lexicalCursor = resolvePathFromBasePreservingWindowsRoot(
    context.state.lexicalCursor,
    "..",
  );
  advanceCanonicalCursorForSegment(context, "..");
  if (context.state.missingDepth > 0) context.state.missingDepth -= 1;
}

function assertDirectoryBeforeMoreSegments(
  stat: fs.Stats | BigIntStats,
  pathname: string,
  isLast: boolean,
): void {
  if (!isLast && !stat.isDirectory()) {
    throw Object.assign(new Error(`Path component is not a directory: ${pathname}`), { code: "ENOTDIR" });
  }
}

function assertResolvedLinkDirectory(pathname: string, isLast: boolean): void {
  if (isLast) return;
  const stat = fs.statSync(pathForWindowsFilesystem(pathname));
  assertDirectoryBeforeMoreSegments(stat, pathname, isLast);
}

type LexicalResolutionParams = {
  params: ResolveRootPathParams;
  rawAbsolutePath: string;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
  observationEligible: boolean;
};

// Both public APIs use synchronous metadata; only canonicalization and ancestor
// existence differ. Promise wrappers preserve the asynchronous rejection API.
function traverseRootPath(
  params: ResolveRootPathParams,
  { mode = "native", observation: observationOutput, observeRoot, removalReceipts }: RootPathTraversalOptions,
): ResolvedRootPath {
  const input = captureValidRootPathInputs(params);
  const rawAbsolutePath = absolutePathWithRawSegments(input.absolutePath);
  const rootPath = resolvePathPreservingWindowsRoot(input.rootPath);
  const absolutePath = resolvePathPreservingWindowsRoot(rawAbsolutePath);
  const rootCanonicalPath = input.rootCanonicalPath
    ? resolvePathPreservingWindowsRoot(input.rootCanonicalPath)
    : resolveExistingAncestor(rootPath, mode);
  assertNoWindowsPathAlias(rootPath);
  assertNoWindowsPathAlias(absolutePath);
  assertNoWindowsPathAlias(rootCanonicalPath);
  observeRoot?.(rootCanonicalPath);
  const context = createLexicalTraversalContext(
    prepareRootTraversal(input, rootPath, rootCanonicalPath, absolutePath, rawAbsolutePath),
  );
  const { state } = context;
  const observation = createLexicalTraversalObservation(context, observationOutput?.request);

  for (let idx = 0; idx < state.segments.length; idx += 1) {
    const segment = state.segments[idx] ?? "";
    const isLast = idx === state.segments.length - 1;
    if (segment === ".") continue;
    if (segment === "..") {
      applyParentTraversalStep(context);
      continue;
    }
    state.lexicalCursor = path.join(state.lexicalCursor, segment);
    if (state.missingDepth > 0) {
      advanceCanonicalCursorForSegment(context, segment);
      state.missingDepth += 1;
      continue;
    }
    let stat: fs.Stats | BigIntStats | undefined;
    let observed: ReturnType<typeof inspectRootPathTraversalEntry> | undefined;
    try {
      if (removalReceipts && !isLast) {
        const directoryStat = fs.lstatSync(pathForWindowsFilesystem(state.lexicalCursor), { bigint: true });
        if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink()) {
          removalReceipts.observeDirectory(state.lexicalCursor, directoryStat);
        }
        stat = directoryStat;
      } else {
        const directorySlot = observation?.enabled === true && idx === observation.directoryIndex;
        const targetSlot = observation?.enabled === true && idx === observation.targetIndex;
        const observeExactly = directorySlot || targetSlot;
        if (observeExactly) {
          observed = inspectRootPathTraversalEntry(state.lexicalCursor, directorySlot, observation!);
        }
        stat = isNativeDirectoryObservationGuard(observed)
          ? undefined
          : observed?.stat ?? fs.lstatSync(state.lexicalCursor);
      }
    } catch (error) {
      if (observation?.enabled && observation.request.kind === "stat" &&
        idx === observation.targetIndex && observation.directoryGuard) {
        const parentReceipt: RootPathParentObservationReceipt = {
          kind: "stat-parent",
          rootGuard: observation.request.rootGuard,
          directoryGuard: observation.directoryGuard,
          directoryObserver: observation.directoryObserver,
          targetPath: state.lexicalCursor,
        };
        // Stop here: the generic missing-path fallback would re-admit a parent.
        // Preserve observation-only versus ordinary traversal error precedence.
        throw new RootPathObservationError(
          error instanceof RootPathObservationError ? error.error : sanitizeRootPathError(error),
          parentReceipt,
          !(error instanceof RootPathObservationError),
        );
      }
      if (!isNotFoundPathError(error)) throw error;
      advanceCanonicalCursorForSegment(context, segment);
      state.missingDepth = 1;
      continue;
    }

    if (isNativeDirectoryObservationGuard(observed)) {
      advanceCanonicalCursorForSegment(context, segment);
      captureRootPathObservedDirectory(
        observation!,
        observed,
        state.lexicalCursor,
        state.canonicalCursor,
        context.rootCanonicalPath,
        context.resolveParams.rootIdentity,
      );
      if (idx === observation!.targetIndex) {
        observation!.targetPath = state.canonicalCursor;
        observation!.target = observed;
      }
      continue;
    }
    if (!stat) throw new Error("directory observation did not return metadata");

    const isSymbolicLink = stat.isSymbolicLink();
    if (!isSymbolicLink) assertDirectoryBeforeMoreSegments(stat, state.lexicalCursor, isLast);
    if (isSymbolicLink && (
      (context.resolveParams.rejectFinalSymlink === true && idx === state.finalComponentIndex) ||
      (context.resolveParams.rejectSymlinks === true && isLast)
    )) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    const preserveFinalSymlink = isSymbolicLink && state.allowFinalSymlink && isLast;
    if (!isSymbolicLink || preserveFinalSymlink) {
      state.preserveFinalSymlink = preserveFinalSymlink;
      advanceCanonicalCursorForSegment(context, segment);
      if (observation?.enabled && isSymbolicLink) {
        disableLexicalTraversalObservation(context, observation);
      }
      if (observation?.enabled && idx === observation.directoryIndex) {
        const captured = observed?.identity && captureRootPathObservedDirectory(
          observation,
          observed,
          state.canonicalCursor,
          state.canonicalCursor,
          context.rootCanonicalPath,
          context.resolveParams.rootIdentity,
        );
        if (!captured) disableLexicalTraversalObservation(context, observation);
      }
      if (observation?.enabled && idx === observation.targetIndex) {
        observation.targetPath = state.canonicalCursor;
        observation.target = observed?.identity ? observed : undefined;
      }
      if (state.preserveFinalSymlink) break;
      continue;
    }

    if (observation?.enabled) disableLexicalTraversalObservation(context, observation);

    const linkCanonical = resolveSymlinkHopPath(
      state.lexicalCursor,
      mode,
      context.resolveParams.rejectUnresolvedSymlinks,
    );
    applyResolvedSymlinkHop(context, linkCanonical);
    if (context.resolveParams.rejectSymlinks === true) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    assertResolvedLinkDirectory(linkCanonical, isLast);
  }

  const completeObservation = observation?.enabled === true && observation.directoryGuard !== undefined &&
    observation.targetPath === state.canonicalCursor && observation.target !== undefined;
  const kind = completeObservation
    ? {
      exists: true,
      kind: isNativeDirectoryObservationGuard(observation.target)
        ? "directory" as const
        : toResolvedKind(observation.target!.stat),
    }
    : getPathKindSync(state.canonicalCursor, state.preserveFinalSymlink);
  if (completeObservation && observationOutput) {
    observationOutput.receipt = {
      kind: observation.request.kind,
      rootGuard: observation.request.rootGuard,
      directoryGuard: observation.directoryGuard!,
      directoryObserver: observation.directoryObserver,
      targetPath: observation.targetPath!,
      target: observation.target!,
    };
  }
  return finalizeLexicalResolution(context, kind);
}

function getPathKindSync(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): { exists: boolean; kind: ResolvedRootPathKind } {
  try {
    const operationPath = pathForWindowsFilesystem(absolutePath);
    const stat = preserveFinalSymlink
      ? fs.lstatSync(operationPath)
      : fs.statSync(operationPath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function toResolvedKind(stat: fs.Stats | BigIntStats): ResolvedRootPathKind {
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

function relativeInsideRoot(rootPath: string, targetPath: string): string {
  const relative = path.relative(
    resolvePathPreservingWindowsRoot(rootPath),
    resolvePathPreservingWindowsRoot(targetPath),
  );
  if (!relative || relative === ".") {
    return "";
  }
  if (isPathRelativeEscape(relative)) {
    return "";
  }
  return relative;
}

function assertInsideBoundary(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  rootIdentity?: RootBoundaryIdentity;
  candidatePath: string;
  absolutePath: string;
}): string {
  const admitted = admitPathInsideRoot({
    rootPath: params.rootCanonicalPath,
    candidatePath: params.candidatePath,
    rootIdentity: params.rootIdentity,
  });
  if (admitted) {
    return admitted.path;
  }
  throw new Error(
    `Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`,
  );
}
