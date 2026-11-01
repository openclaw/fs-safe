import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { runAsync, runSync, wait, type Procedure } from "./atomic-io.js";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { isNotFoundPathError, isPathInside, isSymlinkOpenError } from "./path.js";
import { realpathNative, realpathSync } from "./realpath.js";
import {
  assertNoWindowsPathAlias,
  isForeignWindowsShareOrDevicePath,
  pathForWindowsFilesystem,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";
import { errorCauseOptions } from "./root-errors.js";

// Windows native realpath denies delete sharing. Preserve read/publication
// scheduling until canonicalization can safely overlap replacement.
export const synchronousRootTraversal = process.platform === "win32";
export const runRootTraversal = synchronousRootTraversal ? runSync : runAsync;

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

export function* rawPathRelativeToCanonicalRoot(
  candidate: string,
  rootCanonicalPath: string,
  options: {
    rejectSymlinks?: boolean;
    rejectFinalSymlink?: boolean;
    rootIdentity?: RootBoundaryIdentity;
  } = {},
  synchronous = true,
): Procedure<string | undefined> {
  assertNoWindowsPathAlias(candidate);
  assertNoWindowsPathAlias(rootCanonicalPath);
  const absolute = absolutePathWithRawSegments(candidate);
  const raw = process.platform === "win32" ? absolute.replaceAll("/", path.sep) : absolute;
  if (isForeignWindowsShareOrDevicePath(raw, [rootCanonicalPath])) return undefined;
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
      const stat = synchronous ? fs.lstatSync(operationPath) : yield* wait(asyncFs.lstat(operationPath));
      isSymlink = stat.isSymbolicLink();
      // Check the original leaf before canonicalization can erase an entry alias.
      if (isSymlink && options.rejectFinalSymlink && index === finalComponentIndex) {
        throw new FsSafeError("symlink", "final symlink not allowed");
      }
      if (!isSymlink && !stat.isDirectory() && index < segments.length - 1) return undefined;
      traversedSymlink ||= isSymlink;
      canonical = synchronous ? realpathSync.native(operationPath) : yield* wait(realpathNative(operationPath));
      assertNoWindowsPathAlias(canonical);
      if (
        isSymlink && index < segments.length - 1 &&
        !(synchronous ? fs.statSync(pathForWindowsFilesystem(canonical))
          : yield* wait(asyncFs.stat(pathForWindowsFilesystem(canonical)))).isDirectory()
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

function* pathExists(targetPath: string, synchronous: boolean): Procedure<boolean> {
  try {
    return (synchronous ? fs.lstatSync(pathForWindowsFilesystem(targetPath), { throwIfNoEntry: false })
      : yield* wait(asyncFs.lstat(pathForWindowsFilesystem(targetPath)))) !== undefined;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

export async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  return runRootTraversal(resolveExistingAncestorProcedure(targetPath, "native", synchronousRootTraversal));
}

function* ordinaryExists(targetPath: string): Procedure<boolean> {
  return fs.existsSync(pathForWindowsFilesystem(targetPath));
}

export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  return resolveExistingAncestor(targetPath, "ordinary");
}

export type RootPathMetadataMode = "native" | "ordinary";

export function resolveExistingAncestor(
  targetPath: string,
  mode: RootPathMetadataMode,
  preserveRawSegments = false,
  remainingHops = 64,
): string {
  return runSync(resolveExistingAncestorProcedure(targetPath, mode, true, preserveRawSegments, remainingHops));
}

export function* resolveExistingAncestorProcedure(
  targetPath: string,
  mode: RootPathMetadataMode,
  synchronous: boolean,
  preserveRawSegments = false,
  remainingHops = 64,
): Procedure<string> {
  const exists = (pathname: string) => mode === "native" || preserveRawSegments
    ? pathExists(pathname, synchronous) : ordinaryExists(pathname);
  assertNoWindowsPathAlias(targetPath);
  const normalized = resolvePathPreservingWindowsRoot(targetPath);
  assertNoWindowsPathAlias(normalized);
  const candidate = preserveRawSegments ? absolutePathWithRawSegments(targetPath) : normalized;
  let cursor = candidate;
  const filesystemRoot = path.parse(candidate).root;

  while (
    cursor !== filesystemRoot &&
    !(yield* exists(cursor))
  ) {
    cursor = path.dirname(cursor);
  }

  if (!(yield* exists(cursor))) {
    return normalized;
  }

  let rawResolvedAncestor: string;
  try {
    rawResolvedAncestor = synchronous ? realpathSync.native(pathForWindowsFilesystem(cursor))
      : yield* wait(realpathNative(pathForWindowsFilesystem(cursor)));
  } catch (error) {
    if (!preserveRawSegments) return normalized;
    if (!isNotFoundPathError(error)) throw error;
    rawResolvedAncestor = yield* resolveSymlinkHopPath(cursor, mode, false, remainingHops, synchronous);
  }
  assertNoWindowsPathAlias(rawResolvedAncestor);
  const resolvedAncestor = resolvePathPreservingWindowsRoot(rawResolvedAncestor);
  assertNoWindowsPathAlias(resolvedAncestor);
  // Keep a leading suffix separator relative to the canonical ancestor.
  const suffix = candidate.slice(cursor.length);
  if (preserveRawSegments && suffix.split(path.sep).includes("..")) {
    throw new FsSafeError("symlink", "symlink target has an unresolved parent component");
  }
  const resolved = cursor === candidate
    ? resolvedAncestor
    : path.resolve(resolvedAncestor, `.${path.sep}${suffix}`);
  assertNoWindowsPathAlias(resolved);
  return resolved;
}

export function* resolveSymlinkHopPath(
  symlinkPath: string,
  mode: RootPathMetadataMode,
  rejectUnresolved?: boolean,
  remainingHops = 64,
  synchronous = true,
): Procedure<string> {
  try {
    const rawRealPath = synchronous ? realpathSync.native(symlinkPath)
      : yield* wait(realpathNative(symlinkPath));
    assertNoWindowsPathAlias(rawRealPath, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    const realPath = resolvePathPreservingWindowsRoot(rawRealPath);
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return realPath;
  } catch (error) {
    if (isSymlinkOpenError(error) || (rejectUnresolved && isNotFoundPathError(error))) {
      throw new FsSafeError("symlink", "symlink path could not be resolved", errorCauseOptions(error));
    }
    if (!isNotFoundPathError(error)) throw error;
    if (remainingHops <= 0) throw new FsSafeError("symlink", "too many unresolved symlink hops");
    const linkTarget = synchronous ? fs.readlinkSync(symlinkPath) : yield* wait(asyncFs.readlink(symlinkPath));
    assertNoWindowsPathAlias(linkTarget, "filesystem", "symlink target uses a Windows filesystem namespace alias");
    const linkDir = resolvePathPreservingWindowsRoot(path.dirname(symlinkPath));
    // Keep parent segments until the kernel has resolved the existing prefix.
    const targetPath = path.isAbsolute(linkTarget) ? linkTarget
      : path.parse(linkTarget).root ? resolvePathFromBasePreservingWindowsRoot(linkDir, linkTarget)
      : `${linkDir}${path.sep}${linkTarget}`;
    const resolved = yield* resolveExistingAncestorProcedure(targetPath, mode, synchronous, true, remainingHops - 1);
    assertNoWindowsPathAlias(resolved, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return resolved;
  }
}
