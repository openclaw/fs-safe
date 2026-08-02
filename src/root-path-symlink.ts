import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import {
  resolvePathViaExistingAncestor,
  resolvePathViaExistingAncestorSync,
} from "./root-path-existing.js";

function normalizeSymlinkResolutionError(error: unknown): void {
  if (isSymlinkOpenError(error)) {
    throw new FsSafeError("symlink", "symlink path could not be resolved", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!isNotFoundPathError(error)) throw error;
}

export async function resolveSymlinkHopPath(symlinkPath: string): Promise<string> {
  try {
    return path.resolve(await fsp.realpath(symlinkPath));
  } catch (error) {
    normalizeSymlinkResolutionError(error);
    const linkTarget = await fsp.readlink(symlinkPath);
    return resolvePathViaExistingAncestor(path.resolve(path.dirname(symlinkPath), linkTarget));
  }
}

export function resolveSymlinkHopPathSync(symlinkPath: string): string {
  try {
    return path.resolve(fs.realpathSync(symlinkPath));
  } catch (error) {
    normalizeSymlinkResolutionError(error);
    const linkTarget = fs.readlinkSync(symlinkPath);
    return resolvePathViaExistingAncestorSync(path.resolve(path.dirname(symlinkPath), linkTarget));
  }
}
