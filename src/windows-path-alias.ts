import path from "node:path";
import { FsSafeError } from "./errors.js";

export type WindowsPathAliasKind = "filesystem" | "relative";

const COLON = 0x3a;
const FORWARD_SLASH = 0x2f;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const QUESTION_MARK = 0x3f;

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSeparator(code: number): boolean {
  return code === FORWARD_SLASH || code === BACKSLASH;
}

function rootedDriveColonIndex(value: string): number {
  if (
    value.length >= 3 &&
    isAsciiLetter(value.charCodeAt(0)) &&
    value.charCodeAt(1) === COLON &&
    isSeparator(value.charCodeAt(2))
  ) {
    return 1;
  }

  if (
    value.length >= 7 &&
    isSeparator(value.charCodeAt(0)) &&
    isSeparator(value.charCodeAt(1)) &&
    (value.charCodeAt(2) === QUESTION_MARK || value.charCodeAt(2) === DOT) &&
    isSeparator(value.charCodeAt(3)) &&
    isAsciiLetter(value.charCodeAt(4)) &&
    value.charCodeAt(5) === COLON &&
    isSeparator(value.charCodeAt(6))
  ) {
    return 5;
  }

  return -1;
}

function isBareWindowsNamespaceDrive(value: string): boolean {
  return (
    value.length === 6 &&
    isSeparator(value.charCodeAt(0)) &&
    isSeparator(value.charCodeAt(1)) &&
    (value.charCodeAt(2) === QUESTION_MARK || value.charCodeAt(2) === DOT) &&
    isSeparator(value.charCodeAt(3)) &&
    isAsciiLetter(value.charCodeAt(4)) &&
    value.charCodeAt(5) === COLON
  );
}

/**
 * Capture an ordinary Windows drive-relative path without normalizing its raw
 * suffix. This is only for public APIs whose existing contract accepts such
 * paths; callers must still run namespace-alias admission on the result.
 */
export function anchorWindowsDriveRelativePath(value: string): string {
  if (process.platform !== "win32" || path.isAbsolute(value)) return value;
  if (
    value.length < 2 ||
    !isAsciiLetter(value.charCodeAt(0)) ||
    value.charCodeAt(1) !== COLON
  ) {
    return value;
  }
  const drive = value.slice(0, 2);
  const base = path.resolve(drive);
  return `${base}${path.sep}${value.slice(2)}`;
}

/**
 * Resolve a path without letting Node erase the separator from an exact
 * extended-length drive root such as `\\?\C:\`. Bare `\\?\C:` input remains
 * unchanged so the surrounding alias admission rejects it.
 */
export function resolvePathPreservingWindowsRoot(value: string): string {
  if (
    value.length === 7 &&
    process.platform === "win32" &&
    rootedDriveColonIndex(value) === 5
  ) {
    return value.includes("/") ? value.replaceAll("/", "\\") : value;
  }
  const resolved = path.resolve(value);
  if (
    resolved.length === 6 &&
    process.platform === "win32" &&
    isBareWindowsNamespaceDrive(resolved) &&
    !hasWindowsPathAlias(value, "filesystem")
  ) {
    return `${resolved}\\`;
  }
  return resolved;
}

/**
 * Resolve path segments against a base while preserving a namespaced drive
 * root when Node normalizes a legitimate rooted input back to that root.
 * Raw bare namespace drives stay bare so admission checks still reject them.
 */
export function resolvePathFromBasePreservingWindowsRoot(
  base: string,
  ...segments: string[]
): string {
  const resolved = path.resolve(base, ...segments);
  if (
    resolved.length !== 6 ||
    process.platform !== "win32" ||
    !isBareWindowsNamespaceDrive(resolved)
  ) {
    return resolved;
  }
  if (
    hasWindowsPathAlias(base, "filesystem") ||
    segments.some((segment) => hasWindowsPathAlias(segment, "filesystem"))
  ) {
    return resolved;
  }
  return `${resolved}\\`;
}

/**
 * Adapt an admitted namespaced drive root for Node's Windows filesystem layer.
 * Node removes the root separator from these paths during filesystem dispatch,
 * so use the equivalent ordinary drive root for the operation. This is not an
 * admission check: callers must validate attacker-controlled input first.
 */
export function pathForWindowsFilesystem(value: string): string {
  if (
    process.platform !== "win32" ||
    rootedDriveColonIndex(value) !== 5
  ) {
    return value;
  }
  if (value.length === 7) {
    return `${value[4]}:\\`;
  }
  const resolved = path.resolve(value);
  if (
    isBareWindowsNamespaceDrive(resolved) &&
    !hasWindowsPathAlias(value, "filesystem")
  ) {
    return `${resolved[4]}:\\`;
  }
  return value;
}

/** Returns true when a Windows pathname can address an alternate filesystem namespace. */
export function hasWindowsPathAlias(
  value: string,
  kind: WindowsPathAliasKind,
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const firstColon = value.indexOf(":");
  if (firstColon === -1) return false;
  if (kind === "relative") return true;
  return firstColon !== rootedDriveColonIndex(value) || value.indexOf(":", firstColon + 1) !== -1;
}

export function assertNoWindowsPathAlias(
  value: string,
  kind: WindowsPathAliasKind = "filesystem",
  message = "path uses a Windows filesystem namespace alias",
  platform: NodeJS.Platform | string = process.platform,
): void {
  if (hasWindowsPathAlias(value, kind, platform)) {
    throw new FsSafeError("invalid-path", message, {
      details: { reason: "windows-path-alias" },
    });
  }
}

export function isWindowsPathAliasError(error: unknown): error is FsSafeError {
  return error instanceof FsSafeError && error.details?.reason === "windows-path-alias";
}
