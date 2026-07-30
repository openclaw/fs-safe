import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode } from "./path.js";

export function isAlreadyExistsError(error: unknown): boolean {
  return hasNodeErrorCode(error, "EEXIST") || /File exists|EEXIST/i.test(String(error));
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Map low-level write failures to accurate FsSafeError kinds.
 *
 * Do not mask EACCES/EPERM as "path is not a regular file under root" — that
 * message is false for ordinary in-root files the process cannot write
 * (see openclaw/openclaw#115920).
 *
 * Also do not use `denied-path` here: that code is reserved for caller
 * `denyMutations` policy matches (docs/errors.md). OS permission / ROFS
 * failures are operational → `helper-failed`, same family as ENOSPC.
 */
export function normalizePinnedWriteError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  const cause = error instanceof Error ? error : undefined;
  if (hasNodeErrorCode(error, "EACCES") || hasNodeErrorCode(error, "EPERM")) {
    return new FsSafeError("helper-failed", "permission denied", { cause });
  }
  if (hasNodeErrorCode(error, "EROFS")) {
    return new FsSafeError("helper-failed", "read-only filesystem", { cause });
  }
  if (hasNodeErrorCode(error, "ENOSPC")) {
    return new FsSafeError("helper-failed", "no space left on device", { cause });
  }
  if (hasNodeErrorCode(error, "EISDIR")) {
    return new FsSafeError("not-file", "not a file", { cause });
  }
  if (hasNodeErrorCode(error, "ENOENT")) {
    return new FsSafeError("not-found", "file not found", { cause });
  }
  // Fallback: keep prior message, but surface errno when present so diagnosis is possible.
  const code = nodeErrorCode(error);
  const suffix = code ? ` (${code})` : "";
  return new FsSafeError("invalid-path", `path is not a regular file under root${suffix}`, {
    cause,
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
