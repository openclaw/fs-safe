import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";

export type SymlinkPolicy = "reject" | "follow-within-root" | "follow-parents-within-root";
export type MutationSymlinkPolicy = "reject" | "follow-parents-within-root";

export function readSymlinkResolution(symlinks: SymlinkPolicy | undefined) {
  return {
    rejectSymlinks: symlinks !== "follow-within-root" && symlinks !== "follow-parents-within-root",
    rejectFinalSymlink: symlinks === "follow-parents-within-root",
  };
}

export function mutationSymlinkResolution(symlinks: MutationSymlinkPolicy | undefined) {
  if (symlinks !== undefined && symlinks !== "reject" && symlinks !== "follow-parents-within-root") {
    throw new RangeError("mutationSymlinks must be reject or follow-parents-within-root");
  }
  return {
    rejectSymlinks: symlinks === "reject",
    rejectFinalSymlink: symlinks !== undefined,
    resolveCanonical: symlinks !== undefined,
  };
}

// Call after parent fences and immediately before the mutation. This is a
// final-component check, not an atomic conditional rename against another process.
export function assertFinalSymlinkRejected(targetPath: string, reject: boolean | undefined): void {
  if (!reject) return;
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new FsSafeError("symlink", "final symlink not allowed");
    }
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
  }
}
