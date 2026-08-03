import fsSync from "node:fs";
import fs from "node:fs/promises";
import { readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { resolveHomeRelativePath } from "./home-dir.js";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  type SecretFileReadOptions,
} from "./secret-file.js";

type SecretFileReadOutcome =
  | { ok: true; secret: string }
  | { ok: false; code: FsSafeErrorCode; message: string; error?: unknown };

function pathErrorCode(error: unknown): FsSafeErrorCode {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "invalid-path";
}

async function readSecretFileOutcome(
  filePath: string,
  label: string,
  options: SecretFileReadOptions,
): Promise<SecretFileReadOutcome> {
  const resolvedPath = resolveHomeRelativePath(filePath.trim());
  if (!resolvedPath) {
    return { ok: false, code: "invalid-path", message: `${label} file path is empty.` };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_FILE_MAX_BYTES;
  let previewStat;
  try {
    previewStat = await fs.lstat(resolvedPath);
    if (previewStat.isSymbolicLink()) {
      if (options.rejectSymlink) {
        return { ok: false, code: "symlink", message: `${label} file at ${resolvedPath} must not be a symlink.` };
      }
      previewStat = await fs.stat(resolvedPath);
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      code: pathErrorCode(error),
      error: normalized,
      message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  }
  if (!previewStat.isFile()) {
    return { ok: false, code: "not-file", message: `${label} file at ${resolvedPath} must be a regular file.` };
  }
  if (options.rejectHardlinks !== false && previewStat.nlink > 1) {
    return { ok: false, code: "hardlink", message: `${label} file at ${resolvedPath} must not be hardlinked.` };
  }
  if (previewStat.size > maxBytes) {
    return { ok: false, code: "too-large", message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.` };
  }

  let handle: fs.FileHandle | undefined;
  try {
    const realPath = await fs.realpath(resolvedPath);
    const noFollow =
      process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants
        ? fsSync.constants.O_NOFOLLOW
        : 0;
    handle = await fs.open(realPath, fsSync.constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    const pathStat = await fs.lstat(realPath);
    if (
      !openedStat.isFile() ||
      !pathStat.isFile() ||
      !sameFileIdentity(previewStat, openedStat) ||
      !sameFileIdentity(pathStat, openedStat) ||
      (options.rejectHardlinks !== false && openedStat.nlink > 1)
    ) {
      throw new FsSafeError("path-mismatch", "security validation failed");
    }
    const secret = (await readFileHandleBounded(handle, maxBytes)).toString("utf8").trim();
    return secret
      ? { ok: true, secret }
      : { ok: false, code: "invalid-path", message: `${label} file at ${resolvedPath} is empty.` };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      code:
        error instanceof FsSafeError
          ? error.code
          : pathErrorCode(error) === "not-found"
            ? "not-found"
            : "read-failed",
      error: normalized,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readSecretFile(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): Promise<string> {
  const result = await readSecretFileOutcome(filePath, label, options);
  if (result.ok) return result.secret;
  throw new FsSafeError(result.code, result.message, { cause: result.error });
}

export async function tryReadSecretFile(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): Promise<string | undefined> {
  if (!filePath?.trim()) return undefined;
  const result = await readSecretFileOutcome(filePath, label, options);
  if (result.ok) return result.secret;
  if (result.code === "not-found") return undefined;
  throw new FsSafeError(result.code, result.message, { cause: result.error });
}
