import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import type { DirectoryObservationGuard } from "./directory-guard.js";
import { formatErrorDetail, shortPath } from "./error-detail.js";
import { FsSafeError } from "./errors.js";
import {
  assertNoNulPathInput,
  isNotFoundPathError,
  isPathInside,
  isPathRelativeEscape,
} from "./path.js";
import {
  absolutePathWithRawSegments,
  rawPathRelativeToCanonicalRoot,
  resolvePathViaExistingAncestor,
  resolvePathViaExistingAncestorSync,
} from "./root-path-existing.js";
import { resolveSymlinkHopPath, resolveSymlinkHopPathSync } from "./root-path-symlink.js";
import { assertNoDriveRelativePathSegments } from "./safe-path-segment.js";
import { realpathSync } from "./realpath.js";
import { inspectStatObservationSync, type StatObservationReceipt } from "./stat-observation.js";

export { resolvePathViaExistingAncestorSync } from "./root-path-existing.js";

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

export type RootPathObservationKind = "stat" | "directory";

/** An exact receipt owned by one stat/list operation. Never cache it. */
export type RootPathObservationReceipt = {
  kind: RootPathObservationKind;
  rootGuard: DirectoryObservationGuard;
  directoryGuard: DirectoryObservationGuard;
  targetPath: string;
  target: StatObservationReceipt;
};

export type RootPathObservationRequest = {
  kind: RootPathObservationKind;
  rootGuard: DirectoryObservationGuard;
};

export type ObservedRootPath = {
  resolved: ResolvedRootPath;
  receipt?: RootPathObservationReceipt;
};

// Observation-only failures happen after ordinary traversal has admitted the
// name. Keep them distinguishable so Root can preserve the existing error
// precedence instead of reclassifying them as an alias-resolution failure.
export class RootPathObservationError extends Error {
  constructor(readonly error: unknown) {
    super("root path observation failed", { cause: error });
    this.name = "RootPathObservationError";
  }
}

export async function resolveRootPath(
  params: ResolveRootPathParams,
): Promise<ResolvedRootPath> {
  try {
    return await resolveRootPathInternal(params);
  } catch (error) {
    throw sanitizeRootPathError(error);
  }
}

async function resolveRootPathInternal(
  params: ResolveRootPathParams,
  observationRequest?: RootPathObservationRequest,
  observationOutput?: { receipt?: RootPathObservationReceipt },
): Promise<ResolvedRootPath> {
  assertValidRootPathInputs(params);
  params = { ...params, absolutePath: absolutePathWithRawSegments(params.absolutePath) };
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : await resolvePathViaExistingAncestor(rootPath);
  return resolveRootPathLexicalAsync(
    prepareRootTraversal(params, rootPath, rootCanonicalPath, absolutePath),
    observationRequest,
    observationOutput,
  );
}

export async function resolveRootPathWithObservation(
  params: ResolveRootPathParams,
  request: RootPathObservationRequest,
): Promise<ObservedRootPath> {
  const output: { receipt?: RootPathObservationReceipt } = {};
  try {
    const resolved = await resolveRootPathInternal(params, request, output);
    return output.receipt ? { resolved, receipt: output.receipt } : { resolved };
  } catch (error) {
    throw sanitizeRootPathError(error);
  }
}

export function resolveRootPathSync(params: ResolveRootPathParams): ResolvedRootPath {
  try {
    return resolveRootPathSyncInternal(params);
  } catch (error) {
    throw sanitizeRootPathError(error);
  }
}

function resolveRootPathSyncInternal(params: ResolveRootPathParams): ResolvedRootPath {
  assertValidRootPathInputs(params);
  params = { ...params, absolutePath: absolutePathWithRawSegments(params.absolutePath) };
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : resolvePathViaExistingAncestorSync(rootPath);
  return resolveRootPathLexicalSync(prepareRootTraversal(params, rootPath, rootCanonicalPath, absolutePath));
}

function prepareRootTraversal(
  params: ResolveRootPathParams,
  rootPath: string,
  rootCanonicalPath: string,
  absolutePath: string,
): LexicalResolutionParams {
  let raw = params.absolutePath;
  if (rawPathRelativeToRoot(rootPath, raw) === undefined) {
    const relative = rawPathRelativeToRoot(rootCanonicalPath, raw)
      ?? rawPathRelativeToCanonicalRoot(raw, rootCanonicalPath, params);
    if (relative === undefined) {
      throw pathEscapeError({ rootPath, absolutePath: raw, boundaryLabel: params.boundaryLabel });
    }
    raw = `${rootPath}${path.sep}${relative}`;
  }
  return {
    params: raw === params.absolutePath ? params : { ...params, absolutePath: raw },
    rootPath, rootCanonicalPath, absolutePath,
    observationEligible: raw === params.absolutePath,
  };
}

function sanitizeRootPathError(error: unknown): unknown {
  if (error instanceof Error) {
    error.message = formatErrorDetail(error.message);
  }
  return error;
}

function assertValidRootPathInputs(params: ResolveRootPathParams): void {
  assertNoNulPathInput(params.rootPath, "root path contains a NUL byte");
  assertNoNulPathInput(params.absolutePath, "absolute path contains a NUL byte");
  assertNoEmbeddedDriveRelativeSegment(params.rootPath, "root path");
  assertNoEmbeddedDriveRelativeSegment(params.absolutePath, "absolute path");
  if (params.rootCanonicalPath !== undefined) {
    assertNoNulPathInput(params.rootCanonicalPath, "canonical root path contains a NUL byte");
    assertNoEmbeddedDriveRelativeSegment(params.rootCanonicalPath, "canonical root path");
  }
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

type LexicalTraversalState = {
  segments: string[];
  finalComponentIndex: number;
  allowFinalSymlink: boolean;
  canonicalCursor: string;
  lexicalCursor: string;
  preserveFinalSymlink: boolean;
  missingDepth: number;
};

type LexicalTraversalContext = {
  state: LexicalTraversalState;
  resolveParams: ResolveRootPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
  observationEligible: boolean;
};

type LexicalTraversalObservation = {
  enabled: boolean;
  request: RootPathObservationRequest;
  targetIndex: number;
  directoryIndex: number;
  directoryGuard?: DirectoryObservationGuard;
  targetPath?: string;
  target?: StatObservationReceipt;
};


function createLexicalTraversalState(params: {
  params: ResolveRootPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
}): LexicalTraversalState {
  const rawAbsolutePath = params.params.absolutePath;
  const relative = rawPathRelativeToRoot(params.rootPath, rawAbsolutePath);
  if (relative === undefined) throw new Error("Path traversal must begin at the root");
  const segments = splitTraversalSegments(relative);
  return {
    segments,
    finalComponentIndex: segments.findLastIndex((segment) => segment !== "."),
    allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
    canonicalCursor: params.rootCanonicalPath,
    lexicalCursor: params.rootPath,
    preserveFinalSymlink: false,
    missingDepth: 0,
  };
}

function createLexicalTraversalContext(params: {
  params: ResolveRootPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
  observationEligible: boolean;
}): LexicalTraversalContext {
  return {
    state: createLexicalTraversalState(params),
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
): LexicalTraversalObservation | undefined {
  if (!request || !context.observationEligible || request.rootGuard.dir !== context.rootCanonicalPath ||
    request.rootGuard.realPath !== context.rootCanonicalPath) return undefined;
  const relative = rawPathRelativeToRoot(context.rootPath, context.resolveParams.absolutePath);
  if (relative === undefined || relative === "") return undefined;
  const rawSegments = relative.split(process.platform === "win32" ? /[\\/]/ : "/");
  // Keep aliases and unusual spellings on the established general resolver.
  // The fused receipt is only for a straight, existing descendant traversal.
  if (rawSegments.some(segment => segment === "" || segment === "." || segment === "..") ||
    rawSegments.length !== context.state.segments.length) return undefined;
  const targetIndex = context.state.finalComponentIndex;
  if (targetIndex < 0 || targetIndex !== context.state.segments.length - 1) return undefined;
  const directoryIndex = request.kind === "stat" ? targetIndex - 1 : targetIndex;
  return {
    enabled: true,
    request,
    targetIndex,
    directoryIndex,
    directoryGuard: directoryIndex < 0 ? request.rootGuard : undefined,
  };
}

function inspectObservedTraversalEntry(
  pathname: string,
  directorySlot: boolean,
): { stat: fs.Stats | BigIntStats; identity?: StatObservationReceipt["identity"] } {
  const first = process.platform === "win32"
    ? fs.lstatSync(pathname, { bigint: true }) : fs.lstatSync(pathname);
  // Preserve the general resolver's symlink handling and error precedence.
  // Directory slots must also preserve ordinary non-directory handling before
  // Windows zero identities can turn the observation into a policy failure.
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

function captureObservedDirectory(
  context: LexicalTraversalContext,
  observation: LexicalTraversalObservation,
  observed: StatObservationReceipt,
): void {
  if (!observed.stat.isDirectory()) {
    observation.enabled = false;
    return;
  }
  let realPath: string;
  try {
    realPath = realpathSync.native(context.state.canonicalCursor);
  } catch (error) {
    throw new RootPathObservationError(error);
  }
  if (!isPathInside(context.rootCanonicalPath, realPath)) {
    throw new RootPathObservationError(
      new FsSafeError("outside-workspace", "directory is outside workspace root"),
    );
  }
  observation.directoryGuard = {
    dir: context.state.canonicalCursor,
    realPath,
    ...observed,
  };
}

function splitTraversalSegments(value: string): string[] {
  const segments = value
    .split(process.platform === "win32" ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  if (value.endsWith("/") || (process.platform === "win32" && value.endsWith("\\"))) segments.push(".");
  return segments;
}

function rawPathRelativeToRoot(rootPath: string, candidatePath: string): string | undefined {
  if (!path.isAbsolute(candidatePath)) {
    return undefined;
  }
  const root = path.resolve(rootPath);
  const candidate = process.platform === "win32"
    ? candidatePath.replaceAll("/", path.sep)
    : candidatePath;
  if (candidate === root) {
    return "";
  }
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const candidatePrefix = candidate.slice(0, rootWithSep.length);
  const prefixMatches = process.platform === "win32"
    ? candidatePrefix.toLowerCase() === rootWithSep.toLowerCase()
    : candidatePrefix === rootWithSep;
  return prefixMatches ? candidate.slice(rootWithSep.length) : undefined;
}

function assertLexicalCursorInsideBoundary(
  context: LexicalTraversalContext,
  candidatePath: string,
): void {
  assertInsideBoundary({
    boundaryLabel: context.resolveParams.boundaryLabel,
    rootCanonicalPath: context.rootCanonicalPath,
    candidatePath,
    absolutePath: context.absolutePath,
  });
}

function advanceCanonicalCursorForSegment(
  context: LexicalTraversalContext,
  segment: string,
): void {
  context.state.canonicalCursor = path.resolve(context.state.canonicalCursor, segment);
  assertLexicalCursorInsideBoundary(context, context.state.canonicalCursor);
}

function finalizeLexicalResolution(
  context: LexicalTraversalContext,
  kind: { exists: boolean; kind: ResolvedRootPathKind },
): ResolvedRootPath {
  assertLexicalCursorInsideBoundary(context, context.state.canonicalCursor);
  return buildResolvedRootPath({
    absolutePath: context.absolutePath,
    canonicalPath: context.state.canonicalCursor,
    rootPath: context.rootPath,
    rootCanonicalPath: context.rootCanonicalPath,
    kind,
  });
}

function handleLexicalLstatFailure(
  context: LexicalTraversalContext,
  error: unknown,
  segment: string,
): boolean {
  if (!isNotFoundPathError(error)) {
    return false;
  }
  advanceCanonicalCursorForSegment(context, segment);
  context.state.missingDepth = 1;
  return true;
}

function lexicalStatDisposition(params: {
  isSymbolicLink: boolean;
  isLast: boolean;
  rejectSymlinks: boolean | undefined;
  rejectFinalSymlink: boolean;
  allowFinalSymlink: boolean;
}): "continue" | "break" | "resolve-link" {
  if (!params.isSymbolicLink) return "continue";
  if (params.rejectFinalSymlink || (params.rejectSymlinks === true && params.isLast)) {
    throw new FsSafeError("symlink", "symlink path component not allowed");
  }
  return params.allowFinalSymlink && params.isLast ? "break" : "resolve-link";
}

function applyResolvedSymlinkHop(
  context: LexicalTraversalContext,
  linkCanonical: string,
): void {
  if (!isPathInside(context.rootCanonicalPath, linkCanonical)) {
    throw symlinkEscapeError({
      boundaryLabel: context.resolveParams.boundaryLabel,
      rootCanonicalPath: context.rootCanonicalPath,
      symlinkPath: context.state.lexicalCursor,
    });
  }
  context.state.canonicalCursor = linkCanonical;
  context.state.lexicalCursor = linkCanonical;
}

function applyParentTraversalStep(context: LexicalTraversalContext): void {
  context.state.lexicalCursor = path.resolve(context.state.lexicalCursor, "..");
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
  const stat = fs.statSync(pathname);
  assertDirectoryBeforeMoreSegments(stat, pathname, isLast);
}

type LexicalResolutionParams = {
  params: ResolveRootPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
  observationEligible: boolean;
};

async function resolveRootPathLexicalAsync(
  params: LexicalResolutionParams,
  observationRequest?: RootPathObservationRequest,
  observationOutput?: { receipt?: RootPathObservationReceipt },
): Promise<ResolvedRootPath> {
  const context = createLexicalTraversalContext(params);
  const { state } = context;
  const observation = createLexicalTraversalObservation(context, observationRequest);

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
    let stat: fs.Stats | BigIntStats;
    let observed: ReturnType<typeof inspectObservedTraversalEntry> | undefined;
    try {
      const directorySlot = observation?.enabled === true && idx === observation.directoryIndex;
      const targetSlot = observation?.enabled === true && idx === observation.targetIndex;
      const observeExactly = directorySlot || targetSlot;
      if (observeExactly) observed = inspectObservedTraversalEntry(state.lexicalCursor, directorySlot);
      stat = observed ? observed.stat : fs.lstatSync(state.lexicalCursor);
    } catch (error) {
      if (handleLexicalLstatFailure(context, error, segment)) continue;
      throw error;
    }

    const isSymbolicLink = stat.isSymbolicLink();
    if (!isSymbolicLink) assertDirectoryBeforeMoreSegments(stat, state.lexicalCursor, isLast);
    const disposition = lexicalStatDisposition({
      isSymbolicLink,
      isLast,
      rejectSymlinks: isSymbolicLink ? context.resolveParams.rejectSymlinks : undefined,
      rejectFinalSymlink: context.resolveParams.rejectFinalSymlink === true && idx === state.finalComponentIndex,
      allowFinalSymlink: state.allowFinalSymlink,
    });
    if (disposition !== "resolve-link") {
      state.preserveFinalSymlink = disposition === "break";
      advanceCanonicalCursorForSegment(context, segment);
      if (observation?.enabled && isSymbolicLink) observation.enabled = false;
      if (observation?.enabled && idx === observation.directoryIndex) {
        if (observed?.identity) captureObservedDirectory(context, observation, observed as StatObservationReceipt);
        else observation.enabled = false;
      }
      if (observation?.enabled && idx === observation.targetIndex) {
        observation.targetPath = state.canonicalCursor;
        observation.target = observed?.identity ? observed as StatObservationReceipt : undefined;
      }
      if (state.preserveFinalSymlink) break;
      continue;
    }

    if (observation?.enabled) observation.enabled = false;

    const linkCanonical = await resolveSymlinkHopPath(state.lexicalCursor, {
      rejectUnresolved: context.resolveParams.rejectUnresolvedSymlinks,
    });
    applyResolvedSymlinkHop(context, linkCanonical);
    if (context.resolveParams.rejectSymlinks === true) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    assertResolvedLinkDirectory(linkCanonical, isLast);
  }

  const completeObservation = observation?.enabled === true && observation.directoryGuard !== undefined &&
    observation.targetPath === state.canonicalCursor && observation.target !== undefined;
  const kind = completeObservation
    ? { exists: true, kind: toResolvedKind(observation.target!.stat) }
    : await getPathKind(state.canonicalCursor, state.preserveFinalSymlink);
  if (completeObservation && observationOutput) {
    observationOutput.receipt = {
      kind: observation.request.kind,
      rootGuard: observation.request.rootGuard,
      directoryGuard: observation.directoryGuard!,
      targetPath: observation.targetPath!,
      target: observation.target!,
    };
  }
  return finalizeLexicalResolution(context, kind);
}

function resolveRootPathLexicalSync(params: LexicalResolutionParams): ResolvedRootPath {
  const context = createLexicalTraversalContext(params);
  const { state } = context;
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
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(state.lexicalCursor);
    } catch (error) {
      if (handleLexicalLstatFailure(context, error, segment)) continue;
      throw error;
    }

    const isSymbolicLink = stat.isSymbolicLink();
    if (!isSymbolicLink) assertDirectoryBeforeMoreSegments(stat, state.lexicalCursor, isLast);
    const disposition = lexicalStatDisposition({
      isSymbolicLink,
      isLast,
      rejectSymlinks: isSymbolicLink ? context.resolveParams.rejectSymlinks : undefined,
      rejectFinalSymlink: context.resolveParams.rejectFinalSymlink === true && idx === state.finalComponentIndex,
      allowFinalSymlink: state.allowFinalSymlink,
    });
    if (disposition !== "resolve-link") {
      state.preserveFinalSymlink = disposition === "break";
      advanceCanonicalCursorForSegment(context, segment);
      if (state.preserveFinalSymlink) break;
      continue;
    }

    const linkCanonical = resolveSymlinkHopPathSync(state.lexicalCursor, {
      rejectUnresolved: context.resolveParams.rejectUnresolvedSymlinks,
    });
    applyResolvedSymlinkHop(context, linkCanonical);
    if (context.resolveParams.rejectSymlinks === true) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    assertResolvedLinkDirectory(linkCanonical, isLast);
  }

  const kind = getPathKindSync(state.canonicalCursor, state.preserveFinalSymlink);
  return finalizeLexicalResolution(context, kind);
}

function buildResolvedRootPath(params: {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  kind: { exists: boolean; kind: ResolvedRootPathKind };
}): ResolvedRootPath {
  return {
    absolutePath: params.absolutePath,
    canonicalPath: params.canonicalPath,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
    exists: params.kind.exists,
    kind: params.kind.kind,
  };
}

async function getPathKind(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): Promise<{ exists: boolean; kind: ResolvedRootPathKind }> {
  try {
    const stat = preserveFinalSymlink
      ? fs.lstatSync(absolutePath)
      : fs.statSync(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function getPathKindSync(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): { exists: boolean; kind: ResolvedRootPathKind } {
  try {
    const stat = preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath);
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
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
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
  candidatePath: string;
  absolutePath: string;
}): void {
  if (isPathInside(params.rootCanonicalPath, params.candidatePath)) {
    return;
  }
  throw new Error(
    `Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function pathEscapeError(params: {
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): Error {
  return new Error(
    `Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function symlinkEscapeError(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  symlinkPath: string;
}): Error {
  return new Error(
    `Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`,
  );
}
