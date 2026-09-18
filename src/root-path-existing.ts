import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { realpathSync } from "./realpath.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
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

function isFilesystemRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
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
  return resolveExistingAncestor(targetPath, pathExists, realpathSync.native);
}

function pathExistsSync(targetPath: string): boolean {
  return fs.existsSync(pathForWindowsFilesystem(targetPath));
}

export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  return resolveExistingAncestor(targetPath, pathExistsSync, realpathSync);
}

function resolveExistingAncestor(
  targetPath: string,
  exists: (pathname: string) => boolean,
  canonicalize: (pathname: string) => string,
): string {
  assertNoWindowsPathAlias(targetPath);
  const normalized = resolvePathPreservingWindowsRoot(targetPath);
  assertNoWindowsPathAlias(normalized);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (
    !isFilesystemRoot(cursor) &&
    !exists(cursor)
  ) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
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
  const resolved = missingSuffix.length === 0
    ? resolvedAncestor
    : path.resolve(resolvedAncestor, ...missingSuffix);
  assertNoWindowsPathAlias(resolved);
  return resolved;
}
