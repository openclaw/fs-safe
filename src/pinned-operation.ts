import { FsSafeError } from "./errors.js";

export function validatePinnedOperationPayload(payload: Record<string, unknown>): void {
  if (typeof payload.relativePath === "string") {
    validatePinnedRelativePath(payload.relativePath);
  }
  if (typeof payload.relativeParentPath === "string") {
    validatePinnedRelativePath(payload.relativeParentPath);
  }
  if (typeof payload.from === "string") {
    validatePinnedRelativePath(payload.from);
  }
  if (typeof payload.to === "string") {
    validatePinnedRelativePath(payload.to);
  }
}

function validatePinnedRelativePath(relativePath: string): void {
  if (relativePath.length === 0 || relativePath === ".") {
    return;
  }
  if (relativePath.includes("\0")) {
    throw new FsSafeError("invalid-path", "relative path contains a NUL byte");
  }
  if (
    relativePath.startsWith("/") ||
    relativePath.startsWith("//") ||
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
