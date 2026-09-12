import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { isNotFoundPathError, isPathInside } from "./path.js";

export function absolutePathWithRawSegments(candidate: string): string {
  if (path.isAbsolute(candidate)) return candidate;
  const drive = path.parse(candidate).root;
  const base = drive ? path.resolve(drive) : process.cwd();
  return `${base}${path.sep}${candidate.slice(drive.length)}`;
}

export function rawPathRelativeToCanonicalRoot(
  candidate: string,
  rootCanonicalPath: string,
  options: { rejectSymlinks?: boolean } = {},
): string | undefined {
  const absolute = absolutePathWithRawSegments(candidate);
  const raw = process.platform === "win32" ? absolute.replaceAll("/", path.sep) : absolute;
  const filesystemRoot = path.parse(raw).root;
  const segments = raw.slice(filesystemRoot.length).split(path.sep);
  let prefix = filesystemRoot;
  let traversedSymlink = false;
  for (let index = 0; index < segments.length; index += 1) {
    prefix += `${prefix.endsWith(path.sep) ? "" : path.sep}${segments[index]}`;
    let canonical: string;
    let isSymlink = false;
    try {
      const stat = fs.lstatSync(prefix);
      isSymlink = stat.isSymbolicLink();
      if (!isSymlink && !stat.isDirectory() && index < segments.length - 1) return undefined;
      traversedSymlink ||= isSymlink;
      canonical = fs.realpathSync.native(prefix);
      if (isSymlink && index < segments.length - 1 && !fs.statSync(canonical).isDirectory()) return undefined;
      if (isSymlink && !isPathInside(rootCanonicalPath, canonical) && !isPathInside(canonical, rootCanonicalPath)) {
        throw new FsSafeError("outside-workspace", `symlink prefix resolves outside the root ancestry: ${formatErrorDetail(candidate)}`);
      }
    } catch (error) {
      if (error instanceof FsSafeError) throw error;
      if (isSymlink) return undefined;
      continue;
    }
    if (!isPathInside(rootCanonicalPath, canonical)) continue;
    if (options.rejectSymlinks && traversedSymlink) {
      throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    return [path.relative(rootCanonicalPath, canonical), ...segments.slice(index + 1)]
      .filter(Boolean).join(path.sep);
  }
  return undefined;
}

function isFilesystemRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

export async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !(await pathExists(cursor))) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!(await pathExists(cursor))) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(fs.realpathSync.native(cursor));
    return missingSuffix.length === 0
      ? resolvedAncestor
      : path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!fs.existsSync(cursor)) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
    return missingSuffix.length === 0
      ? resolvedAncestor
      : path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}
