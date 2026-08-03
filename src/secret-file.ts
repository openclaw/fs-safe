import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "./absolute-path.js";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
import { resolveHomeRelativePath } from "./home-dir.js";
import { openPinnedFileSync } from "./pinned-open.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import { serializePathWrite } from "./write-queue.js";

export const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;
export const PRIVATE_SECRET_DIR_MODE = 0o700;
export const PRIVATE_SECRET_FILE_MODE = 0o600;

export type SecretFileReadOptions = {
  maxBytes?: number;
  rejectSymlink?: boolean;
  rejectHardlinks?: boolean;
};

type SecretFileReadOutcome =
  | { ok: true; secret: string }
  | { ok: false; code: FsSafeErrorCode; message: string; error?: unknown };

function normalizeSecretReadError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function secretPathErrorCode(error: unknown): FsSafeErrorCode {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "invalid-path";
}

function resolveUserPath(input: string): string {
  return resolveHomeRelativePath(input);
}

function readSecretFileOutcomeSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): SecretFileReadOutcome {
  const trimmedPath = filePath.trim();
  const resolvedPath = resolveUserPath(trimmedPath);
  if (!resolvedPath) {
    return { ok: false, code: "invalid-path", message: `${label} file path is empty.` };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_FILE_MAX_BYTES;

  let previewStat: fs.Stats;
  try {
    previewStat = fs.lstatSync(resolvedPath);
  } catch (error) {
    const normalized = normalizeSecretReadError(error);
    return {
      ok: false,
      code: secretPathErrorCode(error),
      error: normalized,
      message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  }

  if (previewStat.isSymbolicLink()) {
    if (!options.rejectSymlink) {
      try {
        previewStat = fs.statSync(resolvedPath);
      } catch (error) {
        const normalized = normalizeSecretReadError(error);
        return {
          ok: false,
          code: secretPathErrorCode(error),
          error: normalized,
          message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`,
        };
      }
    } else {
      return {
        ok: false,
        code: "symlink",
        message: `${label} file at ${resolvedPath} must not be a symlink.`,
      };
    }
  }
  if (!previewStat.isFile()) {
    return {
      ok: false,
      code: "not-file",
      message: `${label} file at ${resolvedPath} must be a regular file.`,
    };
  }
  if (options.rejectHardlinks !== false && previewStat.nlink > 1) {
    return {
      ok: false,
      code: "hardlink",
      message: `${label} file at ${resolvedPath} must not be hardlinked.`,
    };
  }
  if (previewStat.size > maxBytes) {
    return {
      ok: false,
      code: "too-large",
      message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`,
    };
  }

  const opened = openPinnedFileSync({
    filePath: resolvedPath,
    rejectPathSymlink: options.rejectSymlink,
    rejectHardlinks: options.rejectHardlinks !== false,
  });
  if (!opened.ok) {
    const error = normalizeSecretReadError(
      opened.reason === "validation" ? new Error("security validation failed") : opened.error,
    );
    return {
      ok: false,
      code: opened.reason === "path" ? "not-found" : "path-mismatch",
      error,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`,
    };
  }

  try {
    const raw = readFileDescriptorBoundedSync(opened.fd, maxBytes).toString("utf8");
    const secret = raw.trim();
    if (!secret) {
      return {
        ok: false,
        code: "invalid-path",
        message: `${label} file at ${resolvedPath} is empty.`,
      };
    }
    return { ok: true, secret };
  } catch (error) {
    const normalized = normalizeSecretReadError(error);
    return {
      ok: false,
      code:
        error instanceof FsSafeError && error.code === "too-large"
          ? "too-large"
          : "invalid-path",
      error: normalized,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function readSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): string {
  const result = readSecretFileOutcomeSync(filePath, label, options);
  if (result.ok) {
    return result.secret;
  }
  throw new FsSafeError(result.code, result.message, {
    cause: result.error,
  });
}

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const result = readSecretFileOutcomeSync(filePath, label, options);
  if (result.ok) {
    return result.secret;
  }
  if (result.code === "not-found") {
    return undefined;
  }
  throw new FsSafeError(result.code, result.message, {
    cause: result.error,
  });
}

function isRelativeEscape(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function assertPathWithinRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (!relative || isRelativeEscape(relative)) {
    throw new Error(`Private secret path must stay under ${rootDir}.`);
  }
}

function assertRealPathWithinRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (isRelativeEscape(relative)) {
    throw new Error(`Private secret path must stay under ${rootDir}.`);
  }
}

async function enforcePrivatePathMode(
  resolvedPath: string,
  expectedMode: number,
  kind: "directory" | "file",
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fsp.chmod(resolvedPath, expectedMode);
  const stat = await fsp.stat(resolvedPath);
  const actualMode = stat.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`,
    );
  }
}

async function enforcePrivateFileIdentityAndMode(
  resolvedPath: string,
  expectedIdentity: FileIdentityStat,
  expectedMode: number,
): Promise<void> {
  const noFollowFlag =
    process.platform !== "win32" && "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fsp.open(resolvedPath, fs.constants.O_RDONLY | noFollowFlag);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFileIdentity(openedStat, expectedIdentity)) {
      throw new FsSafeError("path-mismatch", "private secret file changed during write");
    }
    const pathStat = await fsp.lstat(resolvedPath);
    if (pathStat.isSymbolicLink() || !sameFileIdentity(pathStat, openedStat)) {
      throw new FsSafeError("path-mismatch", "private secret path changed during write");
    }
    if (process.platform !== "win32") {
      await handle.chmod(expectedMode);
      const chmodStat = await handle.stat();
      const actualMode = chmodStat.mode & 0o777;
      if (actualMode !== expectedMode) {
        throw new Error(
          `Private secret file ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`,
        );
      }
      const refreshedPathStat = await fsp.lstat(resolvedPath);
      if (refreshedPathStat.isSymbolicLink() || !sameFileIdentity(refreshedPathStat, chmodStat)) {
        throw new FsSafeError("path-mismatch", "private secret path changed during mode check");
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(
  rootDir: string,
  targetDir: string,
  mode: number,
): Promise<{ rootGuard: AsyncDirectoryGuard; targetReal: string }> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetDir);
  await fsp.mkdir(resolvedRoot, { recursive: true, mode });
  const rootStat = await fsp.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Private secret root ${resolvedRoot} must not be a symlink.`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Private secret root ${resolvedRoot} must be a directory.`);
  }
  const rootGuard = await createAsyncDirectoryGuard(resolvedRoot);
  await enforcePrivatePathMode(rootGuard.realPath, mode, "directory");
  await assertAsyncDirectoryGuard(rootGuard);

  if (resolvedTarget === resolvedRoot) {
    return { rootGuard, targetReal: rootGuard.realPath };
  }

  assertPathWithinRoot(resolvedRoot, resolvedTarget);
  const resolvedRootReal = rootGuard.realPath;

  let current = resolvedRoot;
  for (const segment of path
    .relative(resolvedRoot, resolvedTarget)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const parentGuard = await createAsyncDirectoryGuard(path.dirname(current));
    await assertAsyncDirectoryGuard(rootGuard);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Private secret directory component ${current} must not be a symlink.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Private secret directory component ${current} must be a directory.`);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await assertAsyncDirectoryGuard(parentGuard);
      await fsp.mkdir(current, { mode });
    }
    const currentReal = await fsp.realpath(current);
    assertRealPathWithinRoot(resolvedRootReal, currentReal);
    await enforcePrivatePathMode(currentReal, mode, "directory");
    await assertAsyncDirectoryGuard(parentGuard);
    await assertAsyncDirectoryGuard(rootGuard);
  }
  return { rootGuard, targetReal: await fsp.realpath(resolvedTarget) };
}

type SecretFileWriteParams = {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
  mode?: number;
  dirMode?: number;
};

async function secretFileWriteQueueKey(filePath: string): Promise<string> {
  try {
    return await canonicalPathFromExistingAncestor(filePath);
  } catch {
    // Keep validation and its public error shape owned by the write path below.
    return path.resolve(filePath);
  }
}

async function materializeSecretFileAtomic(
  params: SecretFileWriteParams,
  createOnly: boolean,
): Promise<void> {
  const mode = params.mode ?? PRIVATE_SECRET_FILE_MODE;
  const dirMode = params.dirMode ?? PRIVATE_SECRET_DIR_MODE;
  const resolvedRoot = path.resolve(params.rootDir);
  const resolvedFile = path.resolve(params.filePath);
  assertPathWithinRoot(resolvedRoot, resolvedFile);
  const intendedParentDir = path.dirname(resolvedFile);
  const { rootGuard, targetReal } = await ensurePrivateDirectory(
    resolvedRoot,
    intendedParentDir,
    dirMode,
  );
  await assertAsyncDirectoryGuard(rootGuard);
  assertRealPathWithinRoot(rootGuard.realPath, targetReal);
  const parentGuard = await createAsyncDirectoryGuard(targetReal);
  const fileName = path.basename(resolvedFile);
  const finalFilePath = path.join(targetReal, fileName);

  try {
    const stat = await fsp.lstat(finalFilePath);
    if (createOnly) {
      throw new FsSafeError("secret-exists", `Private secret file ${finalFilePath} already exists.`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Private secret file ${finalFilePath} must not be a symlink.`);
    }
    if (!stat.isFile()) {
      throw new Error(`Private secret file ${finalFilePath} must be a regular file.`);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await assertAsyncDirectoryGuard(rootGuard);
  await assertAsyncDirectoryGuard(parentGuard);
  const identity = await runPinnedWriteHelper({
    rootPath: parentGuard.realPath,
    relativeParentPath: "",
    basename: fileName,
    mkdir: false,
    mode,
    overwrite: !createOnly,
    input: { kind: "buffer", data: typeof params.content === "string" ? params.content : Buffer.from(params.content) },
    rootIdentity: { dev: parentGuard.stat.dev, ino: parentGuard.stat.ino },
  });
  await assertAsyncDirectoryGuard(rootGuard);
  await assertAsyncDirectoryGuard(parentGuard);
  await enforcePrivateFileIdentityAndMode(finalFilePath, identity, mode);
}

export async function writeSecretFileAtomic(params: SecretFileWriteParams): Promise<void> {
  const canonicalPath = await secretFileWriteQueueKey(params.filePath);
  await serializePathWrite(canonicalPath, async () => {
    await materializeSecretFileAtomic(params, false);
  });
}

export async function createSecretFileAtomic(params: SecretFileWriteParams): Promise<void> {
  try {
    const canonicalPath = await secretFileWriteQueueKey(params.filePath);
    await serializePathWrite(canonicalPath, async () => {
      await materializeSecretFileAtomic(params, true);
    });
  } catch (error) {
    if (
      (error instanceof FsSafeError && error.code === "already-exists") ||
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new FsSafeError("secret-exists", "Private secret file already exists.", { cause: error });
    }
    throw error;
  }
}
