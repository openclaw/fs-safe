import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { isNotFoundPathError, isPathInside, isSymlinkOpenError } from "./path.js";
import { realpathSync } from "./realpath.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";

export function absolutePathWithRawSegments(candidate: string): string {
  if (path.sep !== "\\") {
    if (path.isAbsolute(candidate)) return candidate;
    const base = process.cwd();
    return `${base}${base.endsWith(path.sep) ? "" : path.sep}${candidate}`;
  }
  const raw = path.sep === "\\" ? candidate.replaceAll("/", "\\") : candidate;
  const absolute = path.isAbsolute(raw);
  if (absolute && raw[0] !== "\\") return raw;
  const drive = path.parse(raw).root;
  if (absolute && drive !== "\\") return raw;
  const base = drive ? path.resolve(drive) : process.cwd();
  return `${base}${base.endsWith(path.sep) ? "" : path.sep}${raw.slice(drive.length)}`;
}

export function rawPathRelativeToCanonicalRoot(
  candidate: string,
  rootCanonicalPath: string,
  options: {
    rejectSymlinks?: boolean;
    rejectFinalSymlink?: boolean;
    rootIdentity?: RootBoundaryIdentity;
  } = {},
): string | undefined {
  assertNoWindowsPathAlias(candidate);
  assertNoWindowsPathAlias(rootCanonicalPath);
  const absolute = absolutePathWithRawSegments(candidate);
  const raw = process.platform === "win32" ? absolute.replaceAll("/", path.sep) : absolute;
  const filesystemRoot = path.parse(raw).root;
  const segments = raw.slice(filesystemRoot.length).split(path.sep);
  const finalComponentIndex = segments.findLastIndex(segment => segment !== "" && segment !== ".");
  let prefix = filesystemRoot;
  let traversedSymlink = false;
  const identityCache = process.platform === "win32" ? new Map<string, boolean>() : undefined;
  for (let index = 0; index < segments.length; index += 1) {
    prefix += `${prefix.endsWith(path.sep) ? "" : path.sep}${segments[index]}`;
    let canonical: string;
    let isSymlink = false;
    try {
      const operationPath = pathForWindowsFilesystem(prefix);
      const stat = fs.lstatSync(operationPath);
      isSymlink = stat.isSymbolicLink();
      // Check the original leaf before canonicalization can erase an entry alias.
      if (isSymlink && options.rejectFinalSymlink && index === finalComponentIndex) {
        throw new FsSafeError("symlink", "final symlink not allowed");
      }
      if (!isSymlink && !stat.isDirectory() && index < segments.length - 1) return undefined;
      traversedSymlink ||= isSymlink;
      canonical = realpathSync.native(operationPath);
      assertNoWindowsPathAlias(canonical);
      if (
        isSymlink && index < segments.length - 1 &&
        !fs.statSync(pathForWindowsFilesystem(canonical)).isDirectory()
      ) return undefined;
      if (isSymlink && !isPathInside(rootCanonicalPath, canonical) && !isPathInside(canonical, rootCanonicalPath)) {
        throw new FsSafeError("outside-workspace", `symlink prefix resolves outside the root ancestry: ${formatErrorDetail(candidate)}`);
      }
    } catch (error) {
      if (error instanceof FsSafeError) throw error;
      if (isSymlink) return undefined;
      continue;
    }
    const admitted = admitPathInsideRoot({
      rootPath: rootCanonicalPath,
      candidatePath: canonical,
      rootIdentity: options.rootIdentity,
      identityCache,
    });
    if (!admitted) continue;
    if (options.rejectSymlinks && traversedSymlink) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    return [admitted.relativePath, ...segments.slice(index + 1)]
      .filter(Boolean).join(path.sep);
  }
  return undefined;
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.lstatSync(pathForWindowsFilesystem(targetPath), { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

export async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  return resolveExistingAncestor(targetPath, "native");
}

function pathExistsSync(targetPath: string): boolean {
  return fs.existsSync(pathForWindowsFilesystem(targetPath));
}

export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  return resolveExistingAncestor(targetPath, "ordinary");
}

export type RootPathMetadataMode = "native" | "ordinary";

export function resolveExistingAncestor(
  targetPath: string,
  mode: RootPathMetadataMode,
): string {
  const exists = mode === "native" ? pathExists : pathExistsSync;
  const canonicalize = mode === "native" ? realpathSync.native : realpathSync;
  assertNoWindowsPathAlias(targetPath);
  const normalized = resolvePathPreservingWindowsRoot(targetPath);
  assertNoWindowsPathAlias(normalized);
  let cursor = normalized;
  const filesystemRoot = path.parse(normalized).root;

  while (
    cursor !== filesystemRoot &&
    !exists(cursor)
  ) {
    cursor = path.dirname(cursor);
  }

  if (!exists(cursor)) {
    return normalized;
  }

  let rawResolvedAncestor: string;
  try {
    rawResolvedAncestor = canonicalize(pathForWindowsFilesystem(cursor));
  } catch {
    return normalized;
  }
  assertNoWindowsPathAlias(rawResolvedAncestor);
  const resolvedAncestor = resolvePathPreservingWindowsRoot(rawResolvedAncestor);
  assertNoWindowsPathAlias(resolvedAncestor);
  // Keep a leading suffix separator relative to the canonical ancestor.
  const resolved = cursor === normalized
    ? resolvedAncestor
    : path.resolve(resolvedAncestor, `.${path.sep}${normalized.slice(cursor.length)}`);
  assertNoWindowsPathAlias(resolved);
  return resolved;
}

export function resolveSymlinkHopPath(
  symlinkPath: string,
  mode: RootPathMetadataMode,
  rejectUnresolved?: boolean,
): string {
  try {
    const canonicalize = mode === "native" ? realpathSync.native : realpathSync;
    const rawRealPath = canonicalize(symlinkPath);
    assertNoWindowsPathAlias(rawRealPath, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    const realPath = resolvePathPreservingWindowsRoot(rawRealPath);
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return realPath;
  } catch (error) {
    if (isSymlinkOpenError(error) || (rejectUnresolved && isNotFoundPathError(error))) {
      throw new FsSafeError("symlink", "symlink path could not be resolved", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!isNotFoundPathError(error)) throw error;
    const linkTarget = fs.readlinkSync(symlinkPath);
    assertNoWindowsPathAlias(linkTarget, "filesystem", "symlink target uses a Windows filesystem namespace alias");
    const linkDir = resolvePathPreservingWindowsRoot(path.dirname(symlinkPath));
    const targetPath = resolvePathFromBasePreservingWindowsRoot(linkDir, linkTarget);
    const resolved = resolveExistingAncestor(targetPath, mode);
    assertNoWindowsPathAlias(resolved, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return resolved;
  }
}
