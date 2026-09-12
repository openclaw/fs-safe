import fs from "node:fs";
import path from "node:path";
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
): Promise<ResolvedRootPath> {
  assertValidRootPathInputs(params);
  params = { ...params, absolutePath: absolutePathWithRawSegments(params.absolutePath) };
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : await resolvePathViaExistingAncestor(rootPath);
  return resolveRootPathLexicalAsync(prepareRootTraversal(params, rootPath, rootCanonicalPath, absolutePath));
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
  return {
    segments: splitTraversalSegments(relative),
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
}): LexicalTraversalContext {
  return {
    state: createLexicalTraversalState(params),
    resolveParams: params.params,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    absolutePath: params.absolutePath,
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
  allowFinalSymlink: boolean;
}): "continue" | "break" | "resolve-link" {
  if (!params.isSymbolicLink) return "continue";
  if (params.rejectSymlinks === true && params.isLast) {
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

function assertDirectoryBeforeMoreSegments(stat: fs.Stats, pathname: string, isLast: boolean): void {
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
};

async function resolveRootPathLexicalAsync(
  params: LexicalResolutionParams,
): Promise<ResolvedRootPath> {
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
      allowFinalSymlink: state.allowFinalSymlink,
    });
    if (disposition !== "resolve-link") {
      state.preserveFinalSymlink = disposition === "break";
      advanceCanonicalCursorForSegment(context, segment);
      if (state.preserveFinalSymlink) break;
      continue;
    }

    const linkCanonical = await resolveSymlinkHopPath(state.lexicalCursor, {
      rejectUnresolved: context.resolveParams.rejectUnresolvedSymlinks,
    });
    applyResolvedSymlinkHop(context, linkCanonical);
    if (context.resolveParams.rejectSymlinks === true) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    assertResolvedLinkDirectory(linkCanonical, isLast);
  }

  const kind = await getPathKind(state.canonicalCursor, state.preserveFinalSymlink);
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

function toResolvedKind(stat: fs.Stats): ResolvedRootPathKind {
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
