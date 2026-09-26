import fs from "node:fs";
import path from "node:path";

import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { isDriveRelativePath } from "./safe-path-segment.js";
import {
  assertNoWindowsPathAlias,
  hasWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export {
  assertNoUnsafeDeviceReadPath,
  isUnsafeDeviceReadPath,
  matchUnsafeDeviceReadPath,
  type UnsafeDeviceReadPathMatch,
  type UnsafeDeviceReadPathOptions,
  type UnsafeDeviceReadPathReason,
} from "./device-path.js";

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);
const POSIX_SEPARATOR_CHAR_CODE = 0x2f;

export function normalizeWindowsPathForComparison(input: string): string {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith("UNC\\")) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  // Lowercase only: this value feeds Windows containment math, so surrounding
  // whitespace is part of the path and must not be trimmed away.
  return normalized.replaceAll("/", "\\").toLowerCase();
}

function resolveWindowsPathForComparison(input: string): string {
  const resolved = path.win32.resolve(input);
  // Ordinary drive paths are already normalized by resolve. Namespace paths
  // retain Node's additional normalization rules before comparison.
  return resolved[1] === ":" && path.win32.isAbsolute(resolved)
    ? resolved.toLowerCase()
    : normalizeWindowsPathForComparison(
      resolved.length === 6 ? resolvePathPreservingWindowsRoot(input) : resolved,
    );
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(
    value && typeof value === "object" && "code" in (value as Record<string, unknown>),
  );
}

export function hasNodeErrorCode(value: unknown, code: string): boolean {
  return isNodeError(value) && value.code === code;
}

export function assertNoNulPathInput(filePath: string, message = "path contains a NUL byte"): void {
  if (filePath.includes("\0")) {
    throw new FsSafeError("invalid-path", message);
  }
}

export function isNotFoundPathError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}

export function isSymlinkOpenError(value: unknown): boolean {
  return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}

export function isPathInside(root: string, target: string): boolean {
  if (process.platform === "win32") {
    const rootForCompare = resolveWindowsPathForComparison(root);
    const targetForCompare = resolveWindowsPathForComparison(target);
    // Resolved drive paths already have canonical separators and case. A full
    // segment prefix needs no second resolution through path.relative.
    // Colon-bearing components keep Node's relative-path interpretation.
    if (
      rootForCompare[1] === ":" && path.win32.isAbsolute(rootForCompare) &&
      !targetForCompare.includes(":", 2) &&
      (targetForCompare === rootForCompare ||
        (targetForCompare.startsWith(rootForCompare) &&
          (rootForCompare.endsWith("\\") || targetForCompare[rootForCompare.length] === "\\")))
    ) {
      return true;
    }
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    const firstSegment = relative.split(path.win32.sep)[0];
    return (
      relative === "" || (firstSegment !== ".." && !path.win32.isAbsolute(relative))
    );
  }

  if (
    root.length > 0 &&
    root.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE &&
    target.length >= root.length &&
    target.charCodeAt(0) === POSIX_SEPARATOR_CHAR_CODE &&
    !target.includes("/..") &&
    (target === root ||
      (target.startsWith(root) &&
        (root.charCodeAt(root.length - 1) === POSIX_SEPARATOR_CHAR_CODE ||
          target.charCodeAt(root.length) === POSIX_SEPARATOR_CHAR_CODE)))
  ) {
    return true;
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const firstSegment = relative.split(path.posix.sep)[0];
  return relative === "" || (firstSegment !== ".." && !path.isAbsolute(relative));
}

export function isPathRelativeEscape(relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) {
    return true;
  }
  if (!relativePath.includes("..")) {
    return false;
  }
  // Use separator-only normalization so Windows device prefixes stay literal.
  const lexicalPath = process.platform === "win32"
    ? relativePath.slice(isDriveRelativePath(relativePath) ? 2 : 0).replaceAll("\\", "/")
    : relativePath;
  const normalized = path.posix.normalize(lexicalPath);
  return normalized === ".." || normalized.startsWith("../");
}

export function resolveSafeBaseDir(rootDir: string): string {
  const resolved = path.resolve(rootDir);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

export function isWithinDir(rootDir: string, targetPath: string): boolean {
  return isPathInside(rootDir, targetPath);
}

export function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null {
  const cached = cache?.get(targetPath);
  if (cached) {
    return cached;
  }
  try {
    const resolved = realpathSync(pathForWindowsFilesystem(targetPath));
    cache?.set(targetPath, resolved);
    cache?.set(resolved, resolved);
    return resolved;
  } catch {
    return null;
  }
}

export function isPathInsideWithRealpath(
  basePath: string,
  candidatePath: string,
  opts?: { requireRealpath?: boolean; cache?: Map<string, string> },
): boolean {
  if (
    hasWindowsPathAlias(basePath, "filesystem") ||
    hasWindowsPathAlias(candidatePath, "filesystem")
  ) {
    return false;
  }
  if (!isPathInside(basePath, candidatePath)) {
    return false;
  }
  const baseReal = safeRealpathSync(basePath, opts?.cache);
  const candidateReal = safeRealpathSync(candidatePath, opts?.cache);
  if (
    (baseReal !== null && hasWindowsPathAlias(baseReal, "filesystem")) ||
    (candidateReal !== null && hasWindowsPathAlias(candidateReal, "filesystem"))
  ) {
    return false;
  }
  if (!baseReal || !candidateReal) {
    return opts?.requireRealpath === false;
  }
  return isPathInside(baseReal, candidateReal);
}

export function safeStatSync(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(pathForWindowsFilesystem(targetPath));
  } catch {
    return null;
  }
}

export function splitSafeRelativePath(relativePath: string): string[] {
  if (relativePath.length === 0 || relativePath === ".") {
    return [];
  }
  assertNoNulPathInput(relativePath, "relative path contains a NUL byte");
  if (relativePath.includes("\\")) {
    throw new FsSafeError("invalid-path", "relative path must use forward slashes");
  }
  if (
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.startsWith("//")
  ) {
    throw new FsSafeError("invalid-path", "relative path must not be absolute");
  }

  const segments = relativePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") {
      throw new FsSafeError("invalid-path", "relative path must not contain '..'");
    }
    if (isDriveRelativePath(segment)) {
      throw new FsSafeError("invalid-path", "relative path must not contain a drive letter");
    }
  }
  assertNoWindowsPathAlias(
    relativePath,
    "relative",
    "relative path uses a Windows filesystem namespace alias",
  );
  return segments;
}

export function resolveSafeRelativePath(rootDir: string, relativePath: string): string {
  assertNoWindowsPathAlias(rootDir, "filesystem", "root dir uses a Windows filesystem namespace alias");
  const root = resolvePathPreservingWindowsRoot(rootDir);
  splitSafeRelativePath(relativePath);
  const target = resolvePathFromBasePreservingWindowsRoot(root, relativePath);
  if (!isPathInside(root, target)) {
    throw new FsSafeError("outside-workspace", "relative path escapes root");
  }
  return target;
}
