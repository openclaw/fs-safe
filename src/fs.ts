import fs from "node:fs";

/**
 * Returns true when `fs.stat()` can stat the path.
 *
 * This follows stat semantics: broken symlinks return false, while symlinks to
 * existing targets return true.
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous counterpart to `pathExists()`, with the same `fs.statSync()`
 * semantics.
 */
export function pathExistsSync(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}
