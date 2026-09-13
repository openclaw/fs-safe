import path from "node:path";
import { isPathRelativeEscape } from "./path.js";
import {
  hasWindowsPathAlias,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

function invalidPath(scopeLabel: string): { ok: false; error: string } {
  return { ok: false, error: `Invalid path: must stay within ${scopeLabel}` };
}

function pathStaysWithinRoot(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return Boolean(relative) && !isPathRelativeEscape(relative);
}

function resolvePathAgainstRoot(root: string, requestedPath: string): string {
  return resolvePathFromBasePreservingWindowsRoot(root, requestedPath);
}

export function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const rootDir = params.rootDir;
  const requestedPath = params.requestedPath;
  const scopeLabel = params.scopeLabel;
  const defaultFileName = params.defaultFileName;
  if (
    hasWindowsPathAlias(rootDir, "filesystem") ||
    hasWindowsPathAlias(requestedPath, "filesystem") ||
    (defaultFileName !== undefined &&
      hasWindowsPathAlias(defaultFileName, "filesystem"))
  ) {
    return invalidPath(scopeLabel);
  }
  const root = resolvePathPreservingWindowsRoot(rootDir);
  if (hasWindowsPathAlias(root, "filesystem")) return invalidPath(scopeLabel);
  const raw = requestedPath.trim();
  if (!raw) {
    if (!defaultFileName) return { ok: false, error: "path is required" };
    const defaultPath = resolvePathAgainstRoot(root, defaultFileName);
    if (
      hasWindowsPathAlias(defaultPath, "filesystem") ||
      !pathStaysWithinRoot(root, defaultPath)
    ) {
      return invalidPath(scopeLabel);
    }
    return { ok: true, path: defaultPath };
  }
  const resolved = resolvePathAgainstRoot(root, raw);
  if (
    hasWindowsPathAlias(resolved, "filesystem") ||
    !pathStaysWithinRoot(root, resolved)
  ) {
    return invalidPath(scopeLabel);
  }
  return { ok: true, path: resolved };
}
