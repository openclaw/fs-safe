import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { formatErrorDetail, shortPath } from "./error-detail.js";
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
  resolvePathViaExistingAncestor,
  resolvePathViaExistingAncestorSync,
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
import { resolveSymlinkHopPath, resolveSymlinkHopPathSync } from "./root-path-symlink.js";
import { assertNoDriveRelativePathSegments } from "./safe-path-segment.js";

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
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : await resolvePathViaExistingAncestor(rootPath);
  return resolveRootPathLexicalAsync(
    prepareRootTraversal(params, rootPath, rootCanonicalPath),
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
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : resolvePathViaExistingAncestorSync(rootPath);
  return resolveRootPathLexicalSync(prepareRootTraversal(params, rootPath, rootCanonicalPath));
}

function prepareRootTraversal(
  params: ResolveRootPathParams,
  rootPath: string,
  rootCanonicalPath: string,
): LexicalResolutionParams {
  const callerAbsolutePath = path.resolve(params.absolutePath);
  let raw = params.absolutePath;
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
    params: raw === params.absolutePath ? params : { ...params, absolutePath: raw },
    rootPath,
    rootCanonicalPath,
    // Preserve the caller-spelling receipt for ordinary aliases. Only a
    // Windows case-fold admission must return the identity-gated Root spelling,
    // because downstream I/O must not reuse the ambiguous caller prefix.
    absolutePath: trustedAbsolutePath ? path.resolve(raw) : callerAbsolutePath,
    observationEligible: raw === params.absolutePath && !trustedAbsolutePath,
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
  relativePath: string;
  reuseLexicalCanonical: boolean;
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

function createLexicalTraversalState(params: {
  params: ResolveRootPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
}): LexicalTraversalState {
  const rawAbsolutePath = params.params.absolutePath;
  const relative = admitRawPathInsideRoot(
    params.rootPath,
    rawAbsolutePath,
    params.params.rootIdentity,
  )?.relativePath;
  if (relative === undefined) throw new Error("Path traversal must begin at the root");
  const segments = splitTraversalSegments(relative);
  return {
    segments,
    relativePath: relative,
    reuseLexicalCanonical: false,
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
    : path.resolve(context.state.canonicalCursor, segment);
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
    let stat: fs.Stats | BigIntStats | undefined;
    let observed: ReturnType<typeof inspectRootPathTraversalEntry> | undefined;
    try {
      const directorySlot = observation?.enabled === true && idx === observation.directoryIndex;
      const targetSlot = observation?.enabled === true && idx === observation.targetIndex;
      const observeExactly = directorySlot || targetSlot;
      if (observeExactly) {
        observed = inspectRootPathTraversalEntry(state.lexicalCursor, directorySlot, observation!);
      }
      stat = isNativeDirectoryObservationGuard(observed)
        ? undefined
        : observed?.stat ?? fs.lstatSync(state.lexicalCursor);
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
      if (handleLexicalLstatFailure(context, error, segment)) continue;
      throw error;
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
    ? {
      exists: true,
      kind: isNativeDirectoryObservationGuard(observation.target)
        ? "directory" as const
        : toResolvedKind(observation.target!.stat),
    }
    : await getPathKind(state.canonicalCursor, state.preserveFinalSymlink);
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
