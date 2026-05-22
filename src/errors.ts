export type FsSafeErrorCode =
  | "already-exists"
  | "denied-path"
  | "device-path"
  | "hardlink"
  | "helper-failed"
  | "helper-unavailable"
  | "invalid-path"
  | "insecure-permissions"
  | "not-empty"
  | "not-file"
  | "not-found"
  | "not-owned"
  | "not-removable"
  | "outside-workspace"
  | "path-alias"
  | "path-mismatch"
  | "permission-unverified"
  | "symlink"
  | "timeout"
  | "too-large"
  | "unsupported-platform";

export type FsSafeErrorCategory = "policy" | "operational";

const OPERATIONAL_CODES: ReadonlySet<FsSafeErrorCode> = new Set([
  "helper-failed",
  "helper-unavailable",
  "permission-unverified",
  "timeout",
  "unsupported-platform",
]);

export function categorizeFsSafeError(code: FsSafeErrorCode): FsSafeErrorCategory {
  return OPERATIONAL_CODES.has(code) ? "operational" : "policy";
}

export class FsSafeError extends Error {
  readonly code: FsSafeErrorCode;
  readonly category: FsSafeErrorCategory;

  constructor(code: FsSafeErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FsSafeError";
    this.code = code;
    this.category = categorizeFsSafeError(code);
  }
}
