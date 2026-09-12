import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathInside } from "./path.js";

export function rawPathRelativeToCanonicalRoot(
  candidate: string,
  rootCanonicalPath: string,
  options: { rejectSymlinks?: boolean } = {},
): string | undefined {
  const absolute = path.isAbsolute(candidate) ? candidate : `${process.cwd()}${path.sep}${candidate}`;
  const raw = process.platform === "win32" ? absolute.replaceAll("/", path.sep) : absolute;
  const filesystemRoot = path.parse(raw).root;
  const segments = raw.slice(filesystemRoot.length).split(path.sep);
  let prefix = filesystemRoot;
  for (let index = 0; index < segments.length; index += 1) {
    prefix += `${prefix.endsWith(path.sep) ? "" : path.sep}${segments[index]}`;
    let canonical: string;
    try {
      const isSymlink = fs.lstatSync(prefix).isSymbolicLink();
      if (options.rejectSymlinks && isSymlink) {
        throw new FsSafeError("symlink", "symlink path component not allowed");
      }
      canonical = fs.realpathSync.native(prefix);
      if (isSymlink && !isPathInside(rootCanonicalPath, canonical) && !isPathInside(canonical, rootCanonicalPath)) {
        throw new FsSafeError("outside-workspace", "symlink prefix resolves outside the root ancestry");
      }
    } catch (error) {
      if (error instanceof FsSafeError) throw error;
      continue;
    }
    if (!isPathInside(rootCanonicalPath, canonical)) continue;
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
