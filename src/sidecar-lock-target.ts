import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "./absolute-path.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import type { Root } from "./root-impl.js";
import { anchorWindowsDriveRelativePath, assertNoWindowsPathAlias } from "./windows-path-alias.js";

export function isCwdIndependentAbsolutePath(filePath: string): boolean {
  if (!path.isAbsolute(filePath)) return false;
  // A leading separator on Windows is rooted on the process's current drive.
  return process.platform !== "win32" || path.parse(filePath).root.length > 1;
}

export async function resolveSidecarTargetPath(resolved: string, lockRoot?: Root): Promise<string> {
  assertNoWindowsPathAlias(resolved);
  const dir = path.dirname(resolved);
  if (lockRoot) {
    // The target is an arbitration key, not necessarily inside the lock Root.
    await lockRoot.resolve(".");
    const parent = await canonicalPathFromExistingAncestor(dir);
    await lockRoot.resolve(".");
    assertNoWindowsPathAlias(parent);
    const normalized = path.join(parent, path.basename(resolved));
    assertNoWindowsPathAlias(normalized);
    return normalized;
  }
  await fs.mkdir(recursiveMkdirPath(dir), { recursive: true });
  let parent: string;
  try {
    parent = realpathSync.native(dir);
  } catch {
    return resolved;
  }
  assertNoWindowsPathAlias(parent);
  const normalized = path.join(parent, path.basename(resolved));
  assertNoWindowsPathAlias(normalized);
  return normalized;
}

export async function resolveSidecarLockPaths(
  targetPath: string,
  explicitLockPath: string | undefined,
  lockRoot: Root | undefined,
): Promise<{ lockPath: string; normalizedTargetPath: string }> {
  const anchoredTargetPath = anchorWindowsDriveRelativePath(targetPath);
  assertNoWindowsPathAlias(anchoredTargetPath);
  const resolvedTargetPath = path.resolve(anchoredTargetPath);
  let resolvedLockPath: string | undefined;
  if (explicitLockPath !== undefined) {
    const anchoredLockPath = anchorWindowsDriveRelativePath(explicitLockPath);
    assertNoWindowsPathAlias(anchoredLockPath);
    resolvedLockPath = isCwdIndependentAbsolutePath(explicitLockPath)
      ? explicitLockPath
      : path.resolve(anchoredLockPath);
  }
  const normalizedTargetPath = await resolveSidecarTargetPath(resolvedTargetPath, lockRoot);
  const lockPath = resolvedLockPath ?? `${normalizedTargetPath}.lock`;
  assertNoWindowsPathAlias(lockPath);
  return { lockPath, normalizedTargetPath };
}
