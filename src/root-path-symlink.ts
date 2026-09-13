import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import {
  resolvePathViaExistingAncestor,
  resolvePathViaExistingAncestorSync,
} from "./root-path-existing.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

type ResolveSymlinkHopOptions = {
  rejectUnresolved?: boolean;
};

function normalizeSymlinkResolutionError(
  error: unknown,
  options: ResolveSymlinkHopOptions,
): void {
  if (
    isSymlinkOpenError(error) ||
    (options.rejectUnresolved && isNotFoundPathError(error))
  ) {
    throw new FsSafeError("symlink", "symlink path could not be resolved", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!isNotFoundPathError(error)) throw error;
}

export async function resolveSymlinkHopPath(
  symlinkPath: string,
  options: ResolveSymlinkHopOptions = {},
): Promise<string> {
  try {
    const realPath = path.resolve(fs.realpathSync.native(symlinkPath));
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return realPath;
  } catch (error) {
    normalizeSymlinkResolutionError(error, options);
    const linkTarget = fs.readlinkSync(symlinkPath);
    assertNoWindowsPathAlias(linkTarget, "filesystem", "symlink target uses a Windows filesystem namespace alias");
    const resolved = await resolvePathViaExistingAncestor(path.resolve(path.dirname(symlinkPath), linkTarget));
    assertNoWindowsPathAlias(resolved, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return resolved;
  }
}

export function resolveSymlinkHopPathSync(
  symlinkPath: string,
  options: ResolveSymlinkHopOptions = {},
): string {
  try {
    const realPath = path.resolve(fs.realpathSync(symlinkPath));
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return realPath;
  } catch (error) {
    normalizeSymlinkResolutionError(error, options);
    const linkTarget = fs.readlinkSync(symlinkPath);
    assertNoWindowsPathAlias(linkTarget, "filesystem", "symlink target uses a Windows filesystem namespace alias");
    const resolved = resolvePathViaExistingAncestorSync(path.resolve(path.dirname(symlinkPath), linkTarget));
    assertNoWindowsPathAlias(resolved, "filesystem", "resolved symlink path uses a Windows filesystem namespace alias");
    return resolved;
  }
}
