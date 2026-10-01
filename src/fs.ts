import fs from "node:fs";
import { pathForWindowsFilesystem } from "./windows-path-alias.js";

/** True if stat succeeds; follows symlinks, so broken links return false. */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    fs.statSync(pathForWindowsFilesystem(filePath));
    return true;
  } catch {
    return false;
  }
}

/** Synchronous {@link pathExists}. */
export function pathExistsSync(filePath: string): boolean {
  try {
    fs.statSync(pathForWindowsFilesystem(filePath));
    return true;
  } catch {
    return false;
  }
}
