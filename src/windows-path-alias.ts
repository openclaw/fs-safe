import path from "node:path";
import { FsSafeError } from "./errors.js";
import {
  hasWindowsDrivePrefix,
  rootedWindowsDriveColonIndex,
  windowsNamespaceMarker,
} from "./windows-path-syntax.js";

export type WindowsPathAliasKind = "filesystem" | "relative";

function isBareWindowsNamespaceDrive(value: string): boolean {
  return value.length === 6 && windowsNamespaceMarker(value) !== undefined &&
    hasWindowsDrivePrefix(value, 4);
}

/**
 * Capture an ordinary Windows drive-relative path without normalizing its raw
 * suffix. This is only for public APIs whose existing contract accepts such
 * paths; callers must still run namespace-alias admission on the result.
 */
export function anchorWindowsDriveRelativePath(value: string): string {
  if (process.platform !== "win32" || path.isAbsolute(value)) return value;
  if (!hasWindowsDrivePrefix(value)) {
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
    rootedWindowsDriveColonIndex(value) === 5
  ) {
    return value.includes("/") ? value.replaceAll("/", "\\") : value;
  }
  const resolved = path.resolve(value);
  return repairResolvedWindowsRoot(value, resolved);
}

/**
 * Preserve a namespaced drive root after a caller has already resolved the
 * input. This lets admission fast paths keep exactly one live path.resolve
 * call while retaining the same root-repair behavior as the general helper.
 */
export function repairResolvedWindowsRoot(value: string, resolved: string): string {
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
    rootedWindowsDriveColonIndex(value) !== 5
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
  return firstColon !== rootedWindowsDriveColonIndex(value) || value.indexOf(":", firstColon + 1) !== -1;
}

export function assertNoWindowsPathAliasForPlatform(
  value: string,
  kind: WindowsPathAliasKind,
  message: string,
  platform: NodeJS.Platform | string | undefined,
): void {
  if (hasWindowsPathAlias(value, kind, platform)) {
    throw new FsSafeError("invalid-path", message, {
      details: { reason: "windows-path-alias" },
    });
  }
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
