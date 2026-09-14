import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isPathInside, splitSafeRelativePath } from "./path.js";

export function assertRelativePath(relativePath: string): string {
  const raw = relativePath.trim();
  if (!raw || raw !== relativePath) {
    throw new FsSafeError("invalid-path", "store key must be non-empty and unpadded");
  }
  const segments = splitSafeRelativePath(raw);
  if (
    segments.length === 0 ||
    segments.join("/") !== raw ||
    raw.normalize("NFC") !== raw ||
    segments.some((segment) => /[ .]$/u.test(segment))
  ) {
    throw new FsSafeError("invalid-path", "store key must use one canonical relative spelling");
  }
  return raw;
}

export function resolveStorePath(rootDir: string, relativePath: string): string {
  const key = assertRelativePath(relativePath);
  // FileStore constructors snapshot an absolute root before this helper runs.
  // Do not re-resolve it: Node drops the trailing separator from an exact
  // Windows namespace drive root such as `\\?\C:\`.
  const root = path.isAbsolute(rootDir) ? rootDir : path.resolve(rootDir);
  // The immutable key already passed segment validation; keep the containment check.
  const target = path.resolve(root, key);
  if (!isPathInside(root, target)) {
    throw new FsSafeError("outside-workspace", "relative path escapes root");
  }
  return target;
}
