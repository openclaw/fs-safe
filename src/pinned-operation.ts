import { FsSafeError } from "./errors.js";

export function validatePinnedRelativePath(relativePath: unknown): void {
  if (typeof relativePath !== "string") return;
  if (relativePath.length === 0 || relativePath === ".") {
    return;
  }
  if (relativePath.includes("\0")) {
    throw new FsSafeError("invalid-path", "relative path contains a NUL byte");
  }
  if (
    relativePath.startsWith("/") ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    throw new FsSafeError("invalid-path", "relative path must not escape root");
  }
  for (const segment of relativePath.split(process.platform === "win32" ? /[\\/]/ : "/")) {
    if (segment === "..") {
      throw new FsSafeError("invalid-path", "relative path must not contain '..'");
    }
  }
}
