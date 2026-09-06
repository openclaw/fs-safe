import fsSync from "node:fs";
import fs from "node:fs/promises";
import { readFileHandleBounded } from "./bounded-read.js";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import {
  assertSecretFilePreview,
  resolveSecretReadPolicy,
  secretPathErrorCode,
  secretReadError,
  trimSecretFileContent,
  type SecretFileReadOptions,
} from "./secret-read-policy.js";

export async function readSecretFile(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): Promise<string> {
  const { resolvedPath, maxBytes } = resolveSecretReadPolicy(filePath, label, options);
  async function inspectInput(symlinkMessage: string): Promise<fsSync.BigIntStats> {
    const stat = options.rejectSymlink
      ? await fs.lstat(resolvedPath, { bigint: true })
      : await fs.stat(resolvedPath, { bigint: true });
    if (options.rejectSymlink && stat.isSymbolicLink()) {
      throw new FsSafeError("symlink", symlinkMessage);
    }
    return stat;
  }

  let previewStat;
  try {
    assertNoUnsafeDeviceReadPath(resolvedPath);
    previewStat = await inspectFileIdentity(() =>
      inspectInput(`${label} file at ${resolvedPath} must not be a symlink.`),
    );
  } catch (error) {
    throw secretReadError(
      error instanceof FsSafeError ? error.code : secretPathErrorCode(error),
      "inspect", label, resolvedPath, error,
    );
  }
  assertSecretFilePreview(previewStat, label, resolvedPath, maxBytes, options.rejectHardlinks !== false);

  let handle: fs.FileHandle | undefined;
  let raw: string;
  try {
    const realPath = await fs.realpath(resolvedPath);
    assertNoUnsafeDeviceReadPath(realPath);
    handle = await fs.open(realPath, resolveReadOpenFlags());
    const openedHandle = handle;
    const openedStat = await inspectFileIdentity(async () => {
      const stat = await openedHandle.stat({ bigint: true });
      if (!stat.isFile() || (options.rejectHardlinks !== false && stat.nlink > 1n)) {
        throw new FsSafeError("path-mismatch", "security validation failed");
      }
      return stat;
    }, previewStat);
    await inspectFileIdentity(async () => {
      const stat = await fs.lstat(realPath, { bigint: true });
      if (!stat.isFile()) throw new FsSafeError("path-mismatch", "security validation failed");
      return stat;
    }, openedStat);
    await inspectFileIdentity(() => inspectInput("secret path became a symlink"), openedStat);
    raw = (await readFileHandleBounded(handle, maxBytes)).toString("utf8");
  } catch (error) {
    throw secretReadError(
      error instanceof FsSafeError
        ? error.code
        : secretPathErrorCode(error) === "not-found" ? "not-found" : "read-failed",
      "read", label, resolvedPath, error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return trimSecretFileContent(raw, label, resolvedPath);
}

export async function tryReadSecretFile(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): Promise<string | undefined> {
  if (!filePath?.trim()) return undefined;
  try {
    return await readSecretFile(filePath, label, options);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") return undefined;
    throw error;
  }
}
