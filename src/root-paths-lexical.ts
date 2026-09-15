import path from "node:path";
import { resolvePathWithinNormalizedRoot, type ResolvePathWithinRootParams } from "./path-scope-lexical.js";
import {
  hasWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

function invalidPath(scopeLabel: string): { ok: false; error: string } {
  return { ok: false, error: `Invalid path: must stay within ${scopeLabel}` };
}

export function resolvePathWithinRoot(
  params: ResolvePathWithinRootParams,
): { ok: true; path: string } | { ok: false; error: string } {
  const rootDir = params.rootDir;
  if (typeof rootDir !== "string") path.resolve(rootDir);
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
  return resolvePathWithinNormalizedRoot({ rootDir, requestedPath, scopeLabel, defaultFileName }, root);
}
