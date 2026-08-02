import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode, isNodeError, isNotFoundPathError } from "./path.js";

const REMOVE_NOT_EMPTY_CODES = new Set(["ENOTEMPTY", "EEXIST"]);

export function isAlreadyExistsError(error: unknown): boolean {
  return hasNodeErrorCode(error, "EEXIST") || /File exists|EEXIST/i.test(String(error));
}

export function normalizePinnedWriteError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  if (isNotFoundPathError(error)) {
    return new FsSafeError("not-found", "file not found", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return new FsSafeError("invalid-path", "path is not a regular file under root", {
    cause: error instanceof Error ? error : undefined,
  });
}

export function normalizePinnedPathError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  return new FsSafeError("path-alias", "path is not under root", {
    cause: error instanceof Error ? error : undefined,
  });
}

export function normalizeRemoveGuardError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  if (isNotFoundPathError(error)) {
    return new FsSafeError("not-found", "file not found", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return normalizePinnedPathError(error);
}

export function normalizeRemovePathError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  if (!isNodeError(error) || typeof error.code !== "string") {
    return normalizePinnedPathError(error);
  }
  const cause = error instanceof Error ? error : undefined;
  if (isNotFoundPathError(error)) {
    return new FsSafeError("not-found", "file not found", { cause });
  }
  if (REMOVE_NOT_EMPTY_CODES.has(error.code)) {
    return new FsSafeError("not-empty", "directory is not empty", { cause });
  }
  return new FsSafeError("not-removable", "path could not be removed", { cause });
}
