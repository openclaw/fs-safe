import type { Stats } from "node:fs";
import { FsSafeError } from "./errors.js";

export function inheritedRegularFileMode(stat: Stats): number {
  if (stat.isSymbolicLink()) {
    throw new FsSafeError("symlink", "atomic replace destination must not be a symbolic link");
  }
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", "atomic replace destination must be a regular file");
  }
  return stat.mode & 0o777;
}
