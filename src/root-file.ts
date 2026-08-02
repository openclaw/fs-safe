import fs from "node:fs";
import path from "node:path";
import {
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
} from "./root-path.js";
import type { PathAliasPolicy } from "./path-policy.js";
import {
  openPinnedFileSync,
  type PinnedOpenSyncAllowedType,
  type PinnedOpenSyncFailureReason,
} from "./pinned-open.js";

type BoundaryReadFs = Pick<
  typeof fs,
  | "closeSync"
  | "constants"
  | "fstatSync"
  | "lstatSync"
  | "openSync"
  | "readFileSync"
  | "realpathSync"
>;

export type RootFileOpenFailureReason = PinnedOpenSyncFailureReason | "validation";

export type RootFileOpenResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; rootRealPath: string }
  | { ok: false; reason: RootFileOpenFailureReason; error?: unknown };

export type RootFileOpenFailure = Extract<RootFileOpenResult, { ok: false }>;

export type OpenRootFileSyncParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  rejectSymlinks?: boolean;
  allowedType?: PinnedOpenSyncAllowedType;
  skipLexicalRootCheck?: boolean;
  ioFs?: BoundaryReadFs;
};

export type OpenRootFileParams = OpenRootFileSyncParams & {
  aliasPolicy?: PathAliasPolicy;
};

type ResolvedRootFilePath = {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
};

export function canUseRootFileOpen(ioFs: typeof fs): boolean {
  return (
    typeof ioFs.openSync === "function" &&
    typeof ioFs.closeSync === "function" &&
    typeof ioFs.fstatSync === "function" &&
    typeof ioFs.lstatSync === "function" &&
    typeof ioFs.realpathSync === "function" &&
    typeof ioFs.readFileSync === "function" &&
    typeof ioFs.constants === "object" &&
    ioFs.constants !== null
  );
}

export function openRootFileSync(params: OpenRootFileSyncParams): RootFileOpenResult {
  const ioFs = params.ioFs ?? fs;
  const resolved = resolveRootFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveRootPathSync({
        absolutePath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: params.boundaryLabel,
        rejectSymlinks: params.rejectSymlinks ?? true,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  if (resolved instanceof Promise) {
    return toBoundaryValidationError(new Error("Unexpected async boundary resolution"));
  }
  return finalizeRootFileOpen({
    resolved,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs,
  });
}

export function matchRootFileOpenFailure<T>(
  failure: RootFileOpenFailure,
  handlers: {
    path?: (failure: RootFileOpenFailure) => T;
    validation?: (failure: RootFileOpenFailure) => T;
    io?: (failure: RootFileOpenFailure) => T;
    fallback: (failure: RootFileOpenFailure) => T;
  },
): T {
  switch (failure.reason) {
    case "path":
      return handlers.path ? handlers.path(failure) : handlers.fallback(failure);
    case "validation":
      return handlers.validation ? handlers.validation(failure) : handlers.fallback(failure);
    case "io":
      return handlers.io ? handlers.io(failure) : handlers.fallback(failure);
  }
  return handlers.fallback(failure);
}

function openRootFileResolved(params: {
  absolutePath: string;
  resolvedPath: string;
  rootRealPath: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: PinnedOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): RootFileOpenResult {
  const opened = openPinnedFileSync({
    filePath: params.absolutePath,
    resolvedPath: params.resolvedPath,
    rejectHardlinks: params.rejectHardlinks ?? true,
    maxBytes: params.maxBytes,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
  });
  if (!opened.ok) {
    return opened;
  }
  return {
    ok: true,
    path: opened.path,
    fd: opened.fd,
    stat: opened.stat,
    rootRealPath: params.rootRealPath,
  };
}

function finalizeRootFileOpen(params: {
  resolved: ResolvedRootFilePath | RootFileOpenResult;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: PinnedOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): RootFileOpenResult {
  if ("ok" in params.resolved) {
    return params.resolved;
  }
  return openRootFileResolved({
    absolutePath: params.resolved.absolutePath,
    resolvedPath: params.resolved.resolvedPath,
    rootRealPath: params.resolved.rootRealPath,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
  });
}

export async function openRootFile(
  params: OpenRootFileParams,
): Promise<RootFileOpenResult> {
  const ioFs = params.ioFs ?? fs;
  const maybeResolved = resolveRootFilePathGeneric({
    absolutePath: params.absolutePath,
    resolve: (absolutePath) =>
      resolveRootPath({
        absolutePath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootRealPath,
        boundaryLabel: params.boundaryLabel,
        policy: params.aliasPolicy,
        rejectSymlinks: params.rejectSymlinks ?? true,
        skipLexicalRootCheck: params.skipLexicalRootCheck,
      }),
  });
  const resolved = maybeResolved instanceof Promise ? await maybeResolved : maybeResolved;
  return finalizeRootFileOpen({
    resolved,
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
    ioFs,
  });
}

function toBoundaryValidationError(error: unknown): RootFileOpenResult {
  return { ok: false, reason: "validation", error };
}

function mapResolvedRootPath(
  absolutePath: string,
  resolved: ResolvedRootPath,
): ResolvedRootFilePath {
  return {
    absolutePath,
    resolvedPath: resolved.canonicalPath,
    rootRealPath: resolved.rootCanonicalPath,
  };
}

function resolveRootFilePathGeneric(params: {
  absolutePath: string;
  resolve: (absolutePath: string) => ResolvedRootPath | Promise<ResolvedRootPath>;
}):
  | ResolvedRootFilePath
  | RootFileOpenResult
  | Promise<ResolvedRootFilePath | RootFileOpenResult> {
  const absolutePath = path.resolve(params.absolutePath);
  try {
    const resolved = params.resolve(absolutePath);
    if (resolved instanceof Promise) {
      return resolved
        .then((value) => mapResolvedRootPath(absolutePath, value))
        .catch((error) => toBoundaryValidationError(error));
    }
    return mapResolvedRootPath(absolutePath, resolved);
  } catch (error) {
    return toBoundaryValidationError(error);
  }
}
