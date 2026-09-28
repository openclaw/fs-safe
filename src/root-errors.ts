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

function descriptorExhaustion(error: unknown): FsSafeError | undefined {
  const pending: unknown[] = [error];
  let details: FsSafeErrorDetails | undefined;
  let code: "EMFILE" | "ENFILE" | undefined;
  const seen = new Set<Error>();
  while (pending.length) {
    const current = pending.pop();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    // Keep boundary/policy failures primary, including combined failures.
    if (current instanceof FsSafeError && current.code !== "helper-failed" && current.code !== "not-removable") return;
    const diagnostic = current as Error & { code?: unknown; error?: unknown; suppressed?: unknown };
    if (current instanceof FsSafeError && (!details || current.details?.cleanup)) details = current.details ?? details;
    if (diagnostic.code === "EMFILE" || diagnostic.code === "ENFILE") code ??= diagnostic.code;
    if (diagnostic.name === "SuppressedError") pending.push(diagnostic.suppressed, diagnostic.error);
    if (current instanceof AggregateError) pending.push(...current.errors);
    pending.push(current.cause);
  }
  if (!code) return;
  const cleanup = details?.cleanup as { status?: unknown } | undefined;
  const publication = details?.publication as { status?: unknown } | undefined;
  const preserved = cleanup?.status === "preserved" && publication?.status === "indeterminate";
  return new FsSafeError("helper-failed", `filesystem write failed: too many open files (${code})${
    preserved ? "; publication outcome is indeterminate; staged file preserved" : ""
  }`, { cause: error, details });
}

export function normalizePinnedWriteError(error: unknown): Error {
  const exhausted = descriptorExhaustion(error);
  if (exhausted) return exhausted;
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
  return new FsSafeError("invalid-path", message, errorCauseOptions(error));
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

/** Existing boundaries retain only Error instances as their cause. */
export function errorCauseOptions(error: unknown): { cause: Error | undefined } {
  return { cause: error instanceof Error ? error : undefined };
}
