import type { BigIntStats } from "node:fs";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";

export const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;

export type SecretFileReadOptions = {
  maxBytes?: number;
  rejectSymlink?: boolean;
  rejectHardlinks?: boolean;
};

export function secretPathErrorCode(error: unknown): FsSafeErrorCode {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "invalid-path";
}

export function secretReadError(
  code: FsSafeErrorCode,
  action: "inspect" | "read",
  label: string,
  resolvedPath: string,
  error: unknown,
): FsSafeError {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new FsSafeError(code, `Failed to ${action} ${label} file at ${resolvedPath}: ${String(cause)}`, { cause });
}

export function assertSecretFilePreview(
  stat: BigIntStats,
  label: string,
  resolvedPath: string,
  maxBytes: number,
  rejectHardlinks: boolean,
): void {
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", `${label} file at ${resolvedPath} must be a regular file.`, { cause: undefined });
  }
  if (rejectHardlinks && stat.nlink > 1n) {
    throw new FsSafeError("hardlink", `${label} file at ${resolvedPath} must not be hardlinked.`, { cause: undefined });
  }
  if (stat.size > maxBytes) {
    throw new FsSafeError("too-large", `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`, { cause: undefined });
  }
}

export function trimSecretFileContent(raw: string, label: string, resolvedPath: string): string {
  const secret = raw.trim();
  if (!secret) {
    throw new FsSafeError("invalid-path", `${label} file at ${resolvedPath} is empty.`, { cause: undefined });
  }
  return secret;
}
