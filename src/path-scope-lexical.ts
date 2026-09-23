import path from "node:path";
import { isPathInside, isPathRelativeEscape } from "./path.js";
import { hasWindowsPathAlias, resolvePathFromBasePreservingWindowsRoot } from "./windows-path-alias.js";

export type ResolvePathWithinRootParams = {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
};

function pathStaysWithinRoot(rootDir: string, candidatePath: string): boolean {
  if (process.platform !== "win32") {
    return candidatePath !== rootDir && isPathInside(rootDir, candidatePath);
  }
  const relative = path.relative(rootDir, candidatePath);
  return Boolean(relative) && !isPathRelativeEscape(relative);
}

export function resolvePathWithinNormalizedRoot(
  params: ResolvePathWithinRootParams,
  root: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const requestedPath = params.requestedPath;
  const defaultFileName = params.defaultFileName;
  const scopeLabel = params.scopeLabel;
  if (
    hasWindowsPathAlias(params.rootDir, "filesystem") ||
    hasWindowsPathAlias(root, "filesystem") ||
    hasWindowsPathAlias(requestedPath, "filesystem") ||
    (defaultFileName !== undefined && hasWindowsPathAlias(defaultFileName, "filesystem"))
  ) {
    return { ok: false, error: `Invalid path: must stay within ${scopeLabel}` };
  }
  const raw = requestedPath.trim();
  if (!raw && !defaultFileName) {
    return { ok: false, error: "path is required" };
  }
  const resolved = resolvePathFromBasePreservingWindowsRoot(root, raw || defaultFileName!);
  if (hasWindowsPathAlias(resolved, "filesystem") || !pathStaysWithinRoot(root, resolved)) {
    return { ok: false, error: `Invalid path: must stay within ${scopeLabel}` };
  }
  return { ok: true, path: resolved };
}
