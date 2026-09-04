import fs, { type BigIntStats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "./absolute-path.js";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, inspectDirectoryIdentity, type AsyncDirectoryGuard } from "./directory-guard.js";
import { pinNodeDirectoryForMode } from "./directory-mode-node.js";
import { assertOwnedDirectory } from "./directory-mode-owner.js";
import { FsSafeError } from "./errors.js";
import { resolveHomeRelativePath } from "./home-dir.js";
import { openPinnedFileSync } from "./pinned-open.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import { ensureTrailingSep } from "./root-context.js";
import { verifyAtomicWriteResult } from "./root-write-verification.js";
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

  const maxBytes = normalizeMaxBytes(options.maxBytes, {
    defaultValue: DEFAULT_SECRET_FILE_MAX_BYTES,
  })!;
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

async function createPrivateDirectory(directory: string, mode: number): Promise<boolean> {
  try {
    await fsp.mkdir(directory, { mode });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function enforcePrivateDirectoryMode(params: {
  realPath: string;
  identity: BigIntStats;
  mode: number;
  created: boolean;
  beforeChmod: () => Promise<void>;
}): Promise<void> {
  if (process.platform === "win32") return;
  const stat = await inspectDirectoryIdentity(params.realPath, params.identity);
  if (!params.created) {
    const actualMode = Number(stat.mode & 0o7777n);
    if (actualMode !== params.mode) {
      throw new FsSafeError(
        "insecure-permissions",
        `Private secret directory ${JSON.stringify(params.realPath)} has insecure permissions ${actualMode.toString(8)}.`,
      );
    }
    return;
  }
  const ownerUid = process.geteuid?.();
  if (ownerUid === undefined) {
    throw new FsSafeError("helper-unavailable", "secret directory initialization requires owner identity");
  }
  const owner = await pinNodeDirectoryForMode(params.realPath, {
    expectedIdentity: params.identity,
    ownerUid,
  });
  try {
    await owner.apply(params.mode, { beforeChmod: params.beforeChmod });
  } finally {
    await owner.close();
  }
}

async function ensurePrivateDirectory(
  rootDir: string,
  targetDir: string,
  mode: number,
): Promise<{ rootGuard: AsyncDirectoryGuard; parentGuard: AsyncDirectoryGuard }> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetDir);
  let rootStat = await fsp.lstat(resolvedRoot, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
  let createdRoot = false;
  if (!rootStat) {
    try {
      createdRoot = await createPrivateDirectory(resolvedRoot, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fsp.mkdir(path.dirname(resolvedRoot), { recursive: true, mode });
      createdRoot = await createPrivateDirectory(resolvedRoot, mode);
    }
    rootStat = await fsp.lstat(resolvedRoot, { bigint: true });
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Private secret root ${resolvedRoot} must not be a symlink.`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Private secret root ${resolvedRoot} must be a directory.`);
  }
  const rootGuard = await createAsyncDirectoryGuard(resolvedRoot);
  assertOwnedDirectory(rootStat, rootGuard.stat);
  await enforcePrivateDirectoryMode({
    realPath: rootGuard.realPath, identity: rootStat, mode, created: createdRoot,
    beforeChmod: () => assertAsyncDirectoryGuard(rootGuard),
  });
  await assertAsyncDirectoryGuard(rootGuard);

  if (resolvedTarget === resolvedRoot) {
    return { rootGuard, parentGuard: rootGuard };
  }

  assertPathWithinRoot(resolvedRoot, resolvedTarget);
  const resolvedRootReal = rootGuard.realPath;

  let current = resolvedRoot;
  let targetGuard = rootGuard;
  for (const segment of path
    .relative(resolvedRoot, resolvedTarget)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const parentGuard = targetGuard;
    let created = false;
    let identity: BigIntStats;
    while (true) {
      await assertAsyncDirectoryGuard(rootGuard);
      await assertAsyncDirectoryGuard(parentGuard);
      try {
        const stat = await fsp.lstat(current, { bigint: true });
        identity = stat;
        if (stat.isSymbolicLink()) {
          throw new Error(`Private secret directory component ${current} must not be a symlink.`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`Private secret directory component ${current} must be a directory.`);
        }
        break;
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
        await assertAsyncDirectoryGuard(parentGuard);
        created = await createPrivateDirectory(current, mode);
        // EEXIST grants no initialization authority; both outcomes need fresh type checks.
      }
    }
    const currentGuard = await createAsyncDirectoryGuard(current);
    assertOwnedDirectory(identity, currentGuard.stat);
    assertRealPathWithinRoot(resolvedRootReal, currentGuard.realPath);
    await enforcePrivateDirectoryMode({
      realPath: currentGuard.realPath, identity, mode, created,
      beforeChmod: async () => {
        await assertAsyncDirectoryGuard(parentGuard);
        await assertAsyncDirectoryGuard(rootGuard);
        await assertAsyncDirectoryGuard(currentGuard);
      },
    });
    await assertAsyncDirectoryGuard(parentGuard);
    await assertAsyncDirectoryGuard(rootGuard);
    await assertAsyncDirectoryGuard(currentGuard);
    targetGuard = currentGuard;
  }
  return { rootGuard, parentGuard: targetGuard };
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

// Internal preparation for private writers and their pre-write locks; not lasting authorization.
export async function prepareSecretFileWrite(
  params: Omit<SecretFileWriteParams, "content">,
): Promise<{
  mode: number;
  rootGuard: AsyncDirectoryGuard;
  parentGuard: AsyncDirectoryGuard;
  fileName: string;
  finalFilePath: string;
}> {
  const mode = params.mode ?? PRIVATE_SECRET_FILE_MODE;
  const dirMode = params.dirMode ?? PRIVATE_SECRET_DIR_MODE;
  const resolvedRoot = path.resolve(params.rootDir);
  const resolvedFile = path.resolve(params.filePath);
  assertPathWithinRoot(resolvedRoot, resolvedFile);
  for (const [kind, value] of [["file", mode], ["directory", dirMode]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0o7777) {
      throw new FsSafeError("invalid-path", `Private secret ${kind} mode must be an integer between 0o0000 and 0o7777.`);
    }
  }
  const intendedParentDir = path.dirname(resolvedFile);
  const { rootGuard, parentGuard } = await ensurePrivateDirectory(
    resolvedRoot,
    intendedParentDir,
    dirMode,
  );
  await assertAsyncDirectoryGuard(rootGuard);
  await assertAsyncDirectoryGuard(parentGuard);
  assertRealPathWithinRoot(rootGuard.realPath, parentGuard.realPath);
  const fileName = path.basename(resolvedFile);
  const finalFilePath = path.join(parentGuard.realPath, fileName);
  return { mode, rootGuard, parentGuard, fileName, finalFilePath };
}

async function materializeSecretFileAtomic(
  params: SecretFileWriteParams,
  createOnly: boolean,
): Promise<void> {
  const { mode, rootGuard, parentGuard, fileName, finalFilePath } = await prepareSecretFileWrite(params);
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
  await runPinnedWriteHelper({
    rootPath: parentGuard.realPath,
    relativeParentPath: "",
    basename: fileName,
    mkdir: false,
    mode,
    overwrite: !createOnly,
    input: { kind: "buffer", data: typeof params.content === "string" ? params.content : Buffer.from(params.content) },
    rootIdentity: { dev: parentGuard.stat.dev, ino: parentGuard.stat.ino },
    verifyPublished: async (fd, expectedIdentity, publishedParentGuard) => {
      await assertAsyncDirectoryGuard(rootGuard);
      await assertAsyncDirectoryGuard(parentGuard);
      await verifyAtomicWriteResult({
        root: {
          rootDir: rootGuard.dir,
          rootReal: rootGuard.realPath,
          rootWithSep: ensureTrailingSep(rootGuard.realPath),
          rootIdentity: { dev: rootGuard.stat.dev, ino: rootGuard.stat.ino },
        },
        targetPath: finalFilePath,
        fd,
        expectedIdentity,
        expectedMode: mode,
        parentGuard: publishedParentGuard,
      });
    },
  });
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
