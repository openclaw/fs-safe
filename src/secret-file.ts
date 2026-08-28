import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "./absolute-path.js";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
import { resolveHomeRelativePath } from "./home-dir.js";
import { openPinnedFileSync } from "./pinned-open.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import {
  assertSecretFilePreview,
  DEFAULT_SECRET_FILE_MAX_BYTES,
  secretPathErrorCode,
  secretReadError,
  trimSecretFileContent,
  type SecretFileReadOptions,
} from "./secret-read-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { serializePathWrite } from "./write-queue.js";

export const PRIVATE_SECRET_DIR_MODE = 0o700;
export const PRIVATE_SECRET_FILE_MODE = 0o600;

export function readSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): string {
  const resolvedPath = resolveHomeRelativePath(filePath.trim());
  if (!resolvedPath) {
    throw new FsSafeError("invalid-path", `${label} file path is empty.`, { cause: undefined });
  }

  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_FILE_MAX_BYTES;
  function inspectInput(symlinkMessage: string): fs.BigIntStats {
    const stat = options.rejectSymlink
      ? fs.lstatSync(resolvedPath, { bigint: true })
      : fs.statSync(resolvedPath, { bigint: true });
    if (options.rejectSymlink && stat.isSymbolicLink()) {
      throw new FsSafeError("symlink", symlinkMessage);
    }
    return stat;
  }

  let previewStat: fs.BigIntStats;
  try {
    previewStat = inspectFileIdentitySync(() =>
      inspectInput(`${label} file at ${resolvedPath} must not be a symlink.`),
    );
  } catch (error) {
    throw secretReadError(
      error instanceof FsSafeError ? error.code : secretPathErrorCode(error),
      "inspect", label, resolvedPath, error,
    );
  }

  assertSecretFilePreview(previewStat, label, resolvedPath, maxBytes, options.rejectHardlinks !== false);

  const opened = openPinnedFileSync({
    filePath: resolvedPath,
    rejectPathSymlink: options.rejectSymlink,
    rejectHardlinks: options.rejectHardlinks !== false,
  });
  if (!opened.ok) {
    throw secretReadError(
      opened.reason === "path" ? "not-found" : "path-mismatch",
      "read", label, resolvedPath,
      opened.reason === "validation" ? new Error("security validation failed") : opened.error,
    );
  }
  let raw: string;
  try {
    const openedIdentity = inspectFileIdentitySync(() => {
      const stat = fs.fstatSync(opened.fd, { bigint: true });
      if (!stat.isFile() || (options.rejectHardlinks !== false && stat.nlink > 1n)) {
        throw new FsSafeError("path-mismatch", "security validation failed");
      }
      return stat;
    }, previewStat);
    inspectFileIdentitySync(() => {
      const stat = fs.lstatSync(opened.path, { bigint: true });
      if (!stat.isFile() || (options.rejectHardlinks !== false && stat.nlink > 1n)) {
        throw new FsSafeError("path-mismatch", "security validation failed");
      }
      return stat;
    }, openedIdentity);
    inspectFileIdentitySync(() => inspectInput("secret path became a symlink"), openedIdentity);
    raw = readFileDescriptorBoundedSync(opened.fd, maxBytes).toString("utf8");
  } catch (error) {
    throw secretReadError(
      error instanceof FsSafeError ? error.code : "read-failed",
      "read", label, resolvedPath, error,
    );
  } finally {
    fs.closeSync(opened.fd);
  }
  return trimSecretFileContent(raw, label, resolvedPath);
}

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  try {
    return readSecretFileSync(filePath, label, options);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") return undefined;
    throw error;
  }
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
