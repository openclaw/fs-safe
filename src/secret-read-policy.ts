import { normalizeMaxBytes } from "./byte-budget.js";
import { resolveHomeRelativePath } from "./home-dir.js";
import fs, { type BigIntStats } from "node:fs";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

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

export function prepareSecretRead(filePath: string, label: string, options: SecretFileReadOptions) {
  const trimmedPath = filePath.trim();
  assertNoWindowsPathAlias(trimmedPath, "filesystem", `${label} file path uses a Windows filesystem namespace alias`);
  const resolvedPath = resolveHomeRelativePath(trimmedPath);
  if (!resolvedPath) {
    throw new FsSafeError("invalid-path", `${label} file path is empty.`, { cause: undefined });
  }
  assertNoWindowsPathAlias(resolvedPath, "filesystem", `${label} file path uses a Windows filesystem namespace alias`);
  const maxBytes = normalizeMaxBytes(options.maxBytes, {
    defaultValue: DEFAULT_SECRET_FILE_MAX_BYTES,
  })!;
  let rejectSymlink: boolean;
  let previewStat: BigIntStats;
  try {
    assertNoUnsafeDeviceReadPath(resolvedPath);
    rejectSymlink = Boolean(options.rejectSymlink);
    previewStat = inspectFileIdentitySync(() =>
      inspectInput(`${label} file at ${resolvedPath} must not be a symlink.`),
    );
  } catch (error) {
    throw secretReadError(
      error instanceof FsSafeError ? error.code : secretPathErrorCode(error),
      "inspect", label, resolvedPath, error,
    );
  }
  function inspectInput(symlinkMessage: string): BigIntStats {
    const stat = rejectSymlink
      ? fs.lstatSync(resolvedPath, { bigint: true })
      : fs.statSync(resolvedPath, { bigint: true });
    if (rejectSymlink && stat.isSymbolicLink()) {
      throw new FsSafeError("symlink", symlinkMessage);
    }
    return stat;
  }
  const rejectHardlinks = options.rejectHardlinks !== false;
  assertSecretFilePreview(previewStat, label, resolvedPath, maxBytes, rejectHardlinks);
  return { resolvedPath, maxBytes, rejectSymlink, rejectHardlinks, previewStat, inspectInput };
}
