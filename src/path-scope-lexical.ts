import path from "node:path";
import { isPathInside, isPathRelativeEscape } from "./path.js";

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
  const raw = params.requestedPath.trim();
  if (!raw) {
    if (!params.defaultFileName) {
      return { ok: false, error: "path is required" };
    }
    const defaultPath = path.resolve(root, params.defaultFileName);
    if (!pathStaysWithinRoot(root, defaultPath)) {
      return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
    }
    return { ok: true, path: defaultPath };
  }
  const resolved = path.resolve(root, raw);
  if (!pathStaysWithinRoot(root, resolved)) {
    return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
  }
  return { ok: true, path: resolved };
}
