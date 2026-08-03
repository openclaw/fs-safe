import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode, isPathRelativeEscape } from "./path.js";

export type AssertNoSymlinkParentsOptions = {
  rootDir: string;
  targetPath: string;
  allowMissing?: boolean;
  allowOutsideRoot?: boolean;
  allowRootChildSymlink?: boolean;
  requireDirectories?: boolean;
  messagePrefix?: string;
};

function resolvePathWalk(params: AssertNoSymlinkParentsOptions): {
  root: string;
  segments: string[];
} | null {
  const root = path.resolve(params.rootDir);
  const target = path.resolve(params.targetPath);
  const relative = path.relative(root, target);
  if (isPathRelativeEscape(relative)) {
    if (params.allowOutsideRoot) {
      return null;
    }
    throw new Error(`${params.messagePrefix ?? "Path"} must stay under ${root}.`);
  }
  return {
    root,
    segments: relative && relative !== "." ? relative.split(path.sep).filter(Boolean) : [],
  };
}

function formatUnsafePath(params: AssertNoSymlinkParentsOptions, current: string): string {
  return `${params.messagePrefix ?? "Path"} must not traverse symlinked directory: ${current}`;
}

export async function assertNoSymlinkParents(
  params: AssertNoSymlinkParentsOptions,
): Promise<void> {
  const walk = resolvePathWalk(params);
  if (!walk) {
    return;
  }
  let current = walk.root;
  for (const [index, segment] of walk.segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        if (params.allowRootChildSymlink && path.dirname(current) === walk.root) {
          continue;
        }
        throw new Error(formatUnsafePath(params, current));
      }
      if ((params.requireDirectories || index < walk.segments.length - 1) && !stat.isDirectory()) {
        throw new FsSafeError(
          "not-file",
          `${params.messagePrefix ?? "Path"} must traverse directories: ${current}`,
        );
      }
    } catch (err) {
      if (hasNodeErrorCode(err, "ENOENT") && params.allowMissing !== false) {
        return;
      }
      throw err;
    }
  }
}

export function assertNoSymlinkParentsSync(
  params: AssertNoSymlinkParentsOptions,
): void {
  const walk = resolvePathWalk(params);
  if (!walk) {
    return;
  }
  let current = walk.root;
  for (const [index, segment] of walk.segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = fsSync.lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (params.allowRootChildSymlink && path.dirname(current) === walk.root) {
          continue;
        }
        throw new Error(formatUnsafePath(params, current));
      }
      if ((params.requireDirectories || index < walk.segments.length - 1) && !stat.isDirectory()) {
        throw new FsSafeError(
          "not-file",
          `${params.messagePrefix ?? "Path"} must traverse directories: ${current}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && params.allowMissing !== false) {
        return;
      }
      throw err;
    }
  }
}
