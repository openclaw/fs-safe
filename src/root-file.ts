import fs from "node:fs";
import path from "node:path";
import {
  resolveRootPathSyncWithCanonicalRootObservation,
  resolveRootPathWithCanonicalRootObservation,
  type ResolvedRootPath,
} from "./root-path.js";
import type { PathAliasPolicy } from "./path-policy.js";
import { readSymlinkResolution, type SymlinkPolicy } from "./root-symlink-policy.js";
import {
  openPinnedFileSync,
  type PinnedOpenSyncAllowedType,
  type PinnedOpenSyncFailureReason,
} from "./pinned-open.js";
import { FsSafeError } from "./errors.js";
import {
  createRootFileFinalAdmission,
  observeCanonicalRoot,
  type CanonicalRootObservation,
} from "./root-file-final-admission.js";

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
  symlinks?: SymlinkPolicy;
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
  boundaryLabel: string;
  rootObservation: Extract<CanonicalRootObservation, { ok: true }>;
};

type AsyncResolutionSnapshot = {
  rootPath: string;
  rootRealPath?: string;
  boundaryLabel: string;
  aliasPolicy?: PathAliasPolicy;
  rejectSymlinks: boolean;
  rejectFinalSymlink: boolean;
  skipLexicalRootCheck?: boolean;
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

function absoluteRootFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const drive = path.parse(filePath).root;
  const base = drive ? path.resolve(drive) : process.cwd();
  return `${base}${path.sep}${filePath.slice(drive.length)}`;
}

export function openRootFileSync(params: OpenRootFileSyncParams): RootFileOpenResult {
  const ioFs = params.ioFs ?? fs;
  const absolutePath = absoluteRootFilePath(params.absolutePath);
  let resolved: ResolvedRootFilePath | RootFileOpenResult;
  try {
    const rootPath = params.rootPath;
    const rootRealPath = params.rootRealPath;
    const boundaryLabel = params.boundaryLabel;
    let rootObservation: CanonicalRootObservation | undefined;
    const resolvedPath = resolveRootPathSyncWithCanonicalRootObservation({
      absolutePath,
      rootPath,
      rootCanonicalPath: rootRealPath,
      boundaryLabel,
      ...readSymlinkResolution(
        params.symlinks ??
          (params.rejectSymlinks === false ? "follow-within-root" : "reject"),
      ),
      skipLexicalRootCheck: params.skipLexicalRootCheck,
    }, rootCanonicalPath => {
      rootObservation = observeCanonicalRoot(ioFs, rootCanonicalPath);
    });
    resolved = mapResolvedRootPath(
      absolutePath,
      boundaryLabel,
      resolvedPath,
      rootObservation,
    );
  } catch (error) {
    resolved = toBoundaryValidationError(error);
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
  boundaryLabel: string;
  rootObservation: Extract<CanonicalRootObservation, { ok: true }>;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: PinnedOpenSyncAllowedType;
  ioFs: BoundaryReadFs;
}): RootFileOpenResult {
  const finalAdmission = createRootFileFinalAdmission(
    params.ioFs,
    params.rootObservation,
    params.boundaryLabel,
  );
  const opened = openPinnedFileSync({
    filePath: params.absolutePath,
    resolvedPath: params.resolvedPath,
    rejectHardlinks: params.rejectHardlinks ?? true,
    maxBytes: params.maxBytes,
    allowedType: params.allowedType,
    ioFs: params.ioFs,
    finalAdmission: ({ path }) => {
      void finalAdmission;
      return path;
    },
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
    boundaryLabel: params.resolved.boundaryLabel,
    rootObservation: params.resolved.rootObservation,
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
  const absolutePath = absoluteRootFilePath(params.absolutePath);
  let resolutionSnapshot: AsyncResolutionSnapshot | RootFileOpenResult;
  try {
    resolutionSnapshot = snapshotAsyncResolution(params);
  } catch (error) {
    resolutionSnapshot = toBoundaryValidationError(error);
  }
  const openSnapshot = {
    maxBytes: params.maxBytes,
    rejectHardlinks: params.rejectHardlinks,
    allowedType: params.allowedType,
  };
  let resolved: ResolvedRootFilePath | RootFileOpenResult;
  if ("ok" in resolutionSnapshot) {
    resolved = resolutionSnapshot;
  } else {
    try {
      let rootObservation: CanonicalRootObservation | undefined;
      const resolvedPath = await resolveRootPathWithCanonicalRootObservation({
        absolutePath,
        rootPath: resolutionSnapshot.rootPath,
        rootCanonicalPath: resolutionSnapshot.rootRealPath,
        boundaryLabel: resolutionSnapshot.boundaryLabel,
        policy: resolutionSnapshot.aliasPolicy,
        rejectSymlinks: resolutionSnapshot.rejectSymlinks,
        rejectFinalSymlink: resolutionSnapshot.rejectFinalSymlink,
        skipLexicalRootCheck: resolutionSnapshot.skipLexicalRootCheck,
      }, rootCanonicalPath => {
        rootObservation = observeCanonicalRoot(ioFs, rootCanonicalPath);
      });
      resolved = mapResolvedRootPath(
        absolutePath,
        resolutionSnapshot.boundaryLabel,
        resolvedPath,
        rootObservation,
      );
    } catch (error) {
      resolved = toBoundaryValidationError(error);
    }
  }
  return finalizeRootFileOpen({
    resolved,
    maxBytes: openSnapshot.maxBytes,
    rejectHardlinks: openSnapshot.rejectHardlinks,
    allowedType: openSnapshot.allowedType,
    ioFs,
  });
}

function toBoundaryValidationError(error: unknown): RootFileOpenResult {
  return { ok: false, reason: "validation", error };
}

function mapResolvedRootPath(
  absolutePath: string,
  boundaryLabel: string,
  resolved: ResolvedRootPath,
  rootObservation: CanonicalRootObservation | undefined,
): ResolvedRootFilePath | RootFileOpenResult {
  if (!rootObservation) {
    return toBoundaryValidationError(new FsSafeError(
      "path-mismatch",
      "canonical root identity was not observed",
    ));
  }
  if (!rootObservation.ok) {
    return toRootObservationError(rootObservation.error);
  }
  return {
    absolutePath,
    resolvedPath: resolved.canonicalPath,
    rootRealPath: resolved.rootCanonicalPath,
    boundaryLabel,
    rootObservation,
  };
}

function snapshotAsyncResolution(params: OpenRootFileParams): AsyncResolutionSnapshot {
  const rootPath = params.rootPath;
  const rootRealPath = params.rootRealPath;
  const boundaryLabel = params.boundaryLabel;
  const sourceAliasPolicy = params.aliasPolicy;
  const aliasPolicy = sourceAliasPolicy == null ? undefined : {
    allowFinalSymlinkForUnlink: sourceAliasPolicy.allowFinalSymlinkForUnlink,
    allowFinalHardlinkForUnlink: sourceAliasPolicy.allowFinalHardlinkForUnlink,
  };
  const symlinkResolution = readSymlinkResolution(
    params.symlinks ?? (params.rejectSymlinks === false ? "follow-within-root" : "reject"),
  );
  return {
    rootPath,
    rootRealPath,
    boundaryLabel,
    aliasPolicy,
    ...symlinkResolution,
    skipLexicalRootCheck: params.skipLexicalRootCheck,
  };
}

function toRootObservationError(error: unknown): RootFileOpenResult {
  if (error instanceof FsSafeError) return toBoundaryValidationError(error);
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
    return { ok: false, reason: "path", error };
  }
  return { ok: false, reason: "io", error };
}
