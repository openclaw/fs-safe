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
  | "read-failed"
  | "secret-exists"
  | "store-reentrant-update"
  | "symlink"
  | "timeout"
  | "too-large"
  | "unsupported-platform";

export type FsSafeErrorCategory = "policy" | "operational";
export type FsSafeErrorDetails = Readonly<Record<string, unknown>>;

const OPERATIONAL_CODES: ReadonlySet<FsSafeErrorCode> = new Set([
  "helper-failed",
  "helper-unavailable",
  "not-empty",
  "not-found",
  "not-removable",
  "permission-unverified",
  "read-failed",
  "timeout",
  "unsupported-platform",
]);

export function categorizeFsSafeError(code: FsSafeErrorCode): FsSafeErrorCategory {
  return OPERATIONAL_CODES.has(code) ? "operational" : "policy";
}

export class FsSafeError extends Error {
  readonly code: FsSafeErrorCode;
  readonly category: FsSafeErrorCategory;
  readonly details?: FsSafeErrorDetails;

  constructor(
    code: FsSafeErrorCode,
    message: string,
    options: { cause?: unknown; details?: FsSafeErrorDetails } = {},
  ) {
    super(message, options);
    this.name = "FsSafeError";
    this.code = code;
    this.category = categorizeFsSafeError(code);
    this.details = options.details;
  }
}
