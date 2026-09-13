import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import {
  isNotFoundPathError,
  isPathInside,
} from "./path.js";
import { root as openRoot } from "./root.js";
import {
  assertNoWindowsPathAlias,
  hasWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import { resolvePathWithinRoot } from "./root-paths-lexical.js";
import {
  assertNoSymlinkSegments,
  ensureDirectoryWithinRoot,
  resolveNearestExistingPath,
  type DirectoryResult,
} from "./root-directory.js";

export { resolvePathWithinRoot } from "./root-paths-lexical.js";
export { ensureDirectoryWithinRoot } from "./root-directory.js";

type InvalidPathResult = { ok: false; error: string };
type ResolvePathsWithinRootParams = {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
};
type ResolvePathsWithinRootResult = { ok: true; paths: string[] } | InvalidPathResult;
export type PathScopeResolveOptions = {
  defaultName?: string;
};
export type PathScopeOptions = {
  label: string;
};
export type PathScope = {
  rootDir: string;
  label: string;
  resolve(
    requestedPath: string,
    options?: PathScopeResolveOptions,
  ): { ok: true; path: string } | { ok: false; error: string };
  resolveAll(requestedPaths: string[]): ResolvePathsWithinRootResult;
  existing(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
  files(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
  writable(
    requestedPath: string,
    options?: PathScopeResolveOptions,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  ensureDir(
    requestedPath: string,
    options?: PathScopeResolveOptions & { mode?: number },
  ): Promise<DirectoryResult>;
};

function invalidPath(scopeLabel: string): InvalidPathResult {
  return {
    ok: false,
    error: `Invalid path: must stay within ${scopeLabel}`,
  };
}

const INVALID_REAL_PATH = Symbol("invalid-real-path");

async function resolveRealPathIfExists(
  targetPath: string,
): Promise<string | undefined | typeof INVALID_REAL_PATH> {
  if (hasWindowsPathAlias(targetPath, "filesystem")) return INVALID_REAL_PATH;
  try {
    const realPath = fsSync.realpathSync.native(
      pathForWindowsFilesystem(targetPath),
    );
    return hasWindowsPathAlias(realPath, "filesystem") ? INVALID_REAL_PATH : realPath;
  } catch {
    return undefined;
  }
}

async function resolveTrustedRootRealPath(rootDir: string): Promise<string | undefined> {
  if (hasWindowsPathAlias(rootDir, "filesystem")) return undefined;
  try {
    const operationPath = pathForWindowsFilesystem(rootDir);
    const rootLstat = fsSync.lstatSync(operationPath);
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) {
      return undefined;
    }
    const realPath = fsSync.realpathSync.native(operationPath);
    return hasWindowsPathAlias(realPath, "filesystem") ? undefined : realPath;
  } catch {
    return undefined;
  }
}

async function validateCanonicalPathWithinRoot(params: {
  rootRealPath: string;
  candidatePath: string;
  expect: "directory" | "file";
}): Promise<"ok" | "not-found" | "invalid"> {
  try {
    const operationPath = pathForWindowsFilesystem(params.candidatePath);
    const candidateLstat = fsSync.lstatSync(operationPath);
    if (candidateLstat.isSymbolicLink()) {
      return "invalid";
    }
    if (params.expect === "directory" && !candidateLstat.isDirectory()) {
      return "invalid";
    }
    if (params.expect === "file" && !candidateLstat.isFile()) {
      return "invalid";
    }
    if (params.expect === "file" && candidateLstat.nlink > 1) {
      return "invalid";
    }
    const candidateRealPath = fsSync.realpathSync.native(operationPath);
    if (hasWindowsPathAlias(candidateRealPath, "filesystem")) return "invalid";
    return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
  } catch (err) {
    return isNotFoundPathError(err) ? "not-found" : "invalid";
  }
}

export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const rootDirInput = params.rootDir;
  const requestedPathInput = params.requestedPath;
  const scopeLabel = params.scopeLabel;
  const defaultFileName = params.defaultFileName;
  const lexical = resolvePathWithinRoot({
    rootDir: rootDirInput,
    requestedPath: requestedPathInput,
    scopeLabel,
    defaultFileName,
  });
  if (!lexical.ok) {
    return lexical;
  }

  const rootDir = resolvePathPreservingWindowsRoot(rootDirInput);
  const rootRealPath = await resolveTrustedRootRealPath(rootDir);
  if (!rootRealPath) {
    return invalidPath(scopeLabel);
  }

  const requestedPath = lexical.path;
  const parentDir = path.dirname(requestedPath);
  const parentStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: parentDir,
    expect: "directory",
  });
  if (parentStatus !== "ok") {
    return invalidPath(scopeLabel);
  }

  const targetStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: requestedPath,
    expect: "file",
  });
  if (targetStatus === "invalid") {
    return invalidPath(scopeLabel);
  }

  return lexical;
}

export function resolvePathsWithinRoot(
  params: ResolvePathsWithinRootParams,
): ResolvePathsWithinRootResult {
  const rootDir = params.rootDir;
  const scopeLabel = params.scopeLabel;
  if (hasWindowsPathAlias(rootDir, "filesystem")) {
    return invalidPath(scopeLabel);
  }
  const requestedPaths = [...params.requestedPaths];
  const resolvedPaths: string[] = [];
  for (const raw of requestedPaths) {
    const pathResult = resolvePathWithinRoot({
      rootDir,
      requestedPath: raw,
      scopeLabel,
    });
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }
    resolvedPaths.push(pathResult.path);
  }
  return { ok: true, paths: resolvedPaths };
}

export async function resolveExistingPathsWithinRoot(
  params: ResolvePathsWithinRootParams,
): Promise<ResolvePathsWithinRootResult> {
  return await resolveCheckedPathsWithinRoot(params, true);
}

export async function resolveStrictExistingPathsWithinRoot(
  params: ResolvePathsWithinRootParams,
): Promise<ResolvePathsWithinRootResult> {
  return await resolveCheckedPathsWithinRoot(params, false);
}

export function pathScope(rootDir: string, options: PathScopeOptions): PathScope {
  const label = options.label;
  const base = { rootDir, scopeLabel: label };
  return {
    rootDir,
    label,
    resolve: (requestedPath, pathOptions) =>
      resolvePathWithinRoot({
        ...base,
        requestedPath,
        defaultFileName: pathOptions?.defaultName,
      }),
    resolveAll: (requestedPaths) =>
      resolvePathsWithinRoot({
        ...base,
        requestedPaths,
      }),
    existing: (requestedPaths) =>
      resolveExistingPathsWithinRoot({
        ...base,
        requestedPaths,
      }),
    files: (requestedPaths) =>
      resolveStrictExistingPathsWithinRoot({
        ...base,
        requestedPaths,
      }),
    writable: (requestedPath, pathOptions) =>
      resolveWritablePathWithinRoot({
        ...base,
        requestedPath,
        defaultFileName: pathOptions?.defaultName,
      }),
    ensureDir: (requestedPath, pathOptions) =>
      ensureDirectoryWithinRoot({
        ...base,
        requestedPath,
        defaultDirName: pathOptions?.defaultName,
        mode: pathOptions?.mode,
      }),
  };
}

async function resolveCheckedPathsWithinRoot(
  params: ResolvePathsWithinRootParams,
  allowMissingFallback: boolean,
): Promise<ResolvePathsWithinRootResult> {
  const rootDirInput = params.rootDir;
  const scopeLabel = params.scopeLabel;
  if (hasWindowsPathAlias(rootDirInput, "filesystem")) {
    return invalidPath(scopeLabel);
  }
  const requestedPaths = [...params.requestedPaths];
  const rootDir = resolvePathPreservingWindowsRoot(rootDirInput);
  if (hasWindowsPathAlias(rootDir, "filesystem")) return invalidPath(scopeLabel);
  const rootRealPathResult = await resolveRealPathIfExists(rootDir);
  if (rootRealPathResult === INVALID_REAL_PATH) return invalidPath(scopeLabel);
  const rootRealPath = rootRealPathResult;
  const root = rootRealPath ? await openRoot(rootDir) : undefined;

  const isInRoot = (relativePath: string) =>
    Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);

  const resolveExistingRelativePath = async (
    requestedPath: string,
  ): Promise<
    { ok: true; relativePath: string; fallbackPath: string } | { ok: false; error: string }
  > => {
    const raw = requestedPath.trim();
    const lexicalPathResult = resolvePathWithinRoot({
      rootDir,
      requestedPath,
      scopeLabel,
    });
    if (lexicalPathResult.ok) {
      return {
        ok: true,
        relativePath: path.relative(rootDir, lexicalPathResult.path),
        fallbackPath: lexicalPathResult.path,
      };
    }
    if (
      !rootRealPath ||
      !raw ||
      !path.isAbsolute(raw) ||
      hasWindowsPathAlias(raw, "filesystem")
    ) {
      return lexicalPathResult;
    }
    try {
      const resolvedExistingPath = fsSync.realpathSync.native(
        pathForWindowsFilesystem(raw),
      );
      if (hasWindowsPathAlias(resolvedExistingPath, "filesystem")) {
        return lexicalPathResult;
      }
      const relativePath = path.relative(rootRealPath, resolvedExistingPath);
      if (!isInRoot(relativePath)) {
        return lexicalPathResult;
      }
      return {
        ok: true,
        relativePath,
        fallbackPath: resolvedExistingPath,
      };
    } catch {
      return lexicalPathResult;
    }
  };

  const resolvedPaths: string[] = [];
  for (const raw of requestedPaths) {
    const pathResult = await resolveExistingRelativePath(raw);
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }

    let opened: Awaited<ReturnType<NonNullable<typeof root>["open"]>> | undefined;
    try {
      if (!root) {
        throw new FsSafeError("not-found", "root dir not found");
      }
      opened = await root.open(pathResult.relativePath);
      resolvedPaths.push(opened.realPath);
    } catch (err) {
      if (allowMissingFallback && err instanceof FsSafeError && err.code === "not-found") {
        if (!rootRealPath) {
          resolvedPaths.push(pathResult.fallbackPath);
          continue;
        }
        try {
          await assertNoSymlinkSegments({
            rootDir,
            targetPath: pathResult.fallbackPath,
            scopeLabel,
          });
          const existingPath = await resolveNearestExistingPath(pathResult.fallbackPath);
          const existingRealPath = fsSync.realpathSync.native(
            pathForWindowsFilesystem(existingPath),
          );
          if (
            hasWindowsPathAlias(existingRealPath, "filesystem") ||
            !isPathInside(rootRealPath, existingRealPath)
          ) {
            return invalidPath(scopeLabel);
          }
        } catch {
          return invalidPath(scopeLabel);
        }
        resolvedPaths.push(pathResult.fallbackPath);
        continue;
      }
      if (err instanceof FsSafeError && err.code === "outside-workspace") {
        return {
          ok: false,
          error: `File is outside ${scopeLabel}`,
        };
      }
      return {
        ok: false,
        error: `Invalid path: must stay within ${scopeLabel} and be a regular non-symlink file`,
      };
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }
  return { ok: true, paths: resolvedPaths };
}
