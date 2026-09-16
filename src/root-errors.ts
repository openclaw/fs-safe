import { FsSafeError, type FsSafeErrorDetails } from "./errors.js";
import { hasNodeErrorCode, isNodeError, isNotFoundPathError } from "./path.js";

const REMOVE_NOT_EMPTY_CODES = new Set(["ENOTEMPTY", "EEXIST"]);
const PINNED_WRITE_ERRNO_MESSAGES = new Map([
  ["EACCES", "permission denied"],
  ["EPERM", "permission denied"],
  ["EROFS", "read-only filesystem"],
  ["ENOSPC", "no space left on device"],
]);

export function fileNotFoundError(cause?: unknown, details?: FsSafeErrorDetails): FsSafeError {
  return cause === undefined
    ? new FsSafeError("not-found", "file not found", { details })
    : new FsSafeError("not-found", "file not found", { cause, details });
}

export function outsideWorkspaceError(): FsSafeError {
  return new FsSafeError("outside-workspace", "file is outside workspace root");
}

export function rootPathChangedError(cause?: Error): FsSafeError {
  return new FsSafeError("path-mismatch", "root path changed during operation", { cause });
}

export function directoryComponentNotDirectoryError(cause?: unknown): FsSafeError {
  return cause === undefined
    ? new FsSafeError("not-file", "directory component must be a directory")
    : new FsSafeError("not-file", "directory component must be a directory", { cause });
}

export function hardlinkedPathNotAllowedError(): FsSafeError {
  return new FsSafeError("hardlink", "hardlinked path not allowed");
}

export function isAlreadyExistsError(error: unknown): boolean {
  return hasNodeErrorCode(error, "EEXIST") || /File exists|EEXIST/i.test(String(error));
}

export function normalizePinnedWriteError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  if (isNotFoundPathError(error)) {
    return fileNotFoundError(error instanceof Error ? error : undefined);
  }
  const code = isNodeError(error) && typeof error.code === "string" && /^E[A-Z0-9_]+$/.test(error.code)
    ? error.code : undefined;
  const message = code
    ? `${PINNED_WRITE_ERRNO_MESSAGES.get(code) ?? "filesystem write failed"} (${code})`
    : "path is not a regular file under root";
  return new FsSafeError("invalid-path", message, {
    cause: error instanceof Error ? error : undefined,
  });
}

export function normalizePinnedPathError(error: unknown, details?: FsSafeErrorDetails): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  return new FsSafeError("path-alias", "path is not under root", {
    cause: error instanceof Error ? error : undefined,
    details,
  });
}

export function normalizeRemoveGuardError(error: unknown, details?: FsSafeErrorDetails): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  if (isNotFoundPathError(error)) {
    return fileNotFoundError(error instanceof Error ? error : undefined, details);
  }
  return normalizePinnedPathError(error, details);
}

export function normalizeRemovePathError(error: unknown, details?: FsSafeErrorDetails): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  if (!isNodeError(error) || typeof error.code !== "string") {
    return normalizePinnedPathError(error, details);
  }
  const cause = error instanceof Error ? error : undefined;
  if (isNotFoundPathError(error)) {
    return fileNotFoundError(cause, details);
  }
  if (REMOVE_NOT_EMPTY_CODES.has(error.code)) {
    return new FsSafeError("not-empty", "directory is not empty", { cause, details });
  }
  return new FsSafeError("not-removable", "path could not be removed", { cause, details });
}

export function throwFsSafeReadError(error: unknown, label: string): never {
  if (error instanceof FsSafeError) {
    throw error;
  }
  if (isNodeError(error)) {
    throw new FsSafeError("read-failed", `${label} target could not be read`, { cause: error });
  }
  throw error;
}
