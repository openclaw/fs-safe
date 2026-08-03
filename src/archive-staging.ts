import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  createAsyncDirectoryGuard,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import {
  ArchiveSecurityError,
  type ArchiveSecurityErrorCode,
} from "./archive-errors.js";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { resolveOpenedFileRealPathForHandle, root } from "./root.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
const ARCHIVE_STAGING_MODE = 0o700;

export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-errors.js";

function symlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return new ArchiveSecurityError(
    "destination-symlink-traversal",
    `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${formatErrorDetail(originalPath)}`,
  );
}

async function createDirectoryIdentityGuard(dir: string): Promise<AsyncDirectoryGuard> {
  try {
    return await createAsyncDirectoryGuard(dir);
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "not-file") {
      throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
    }
    throw err;
  }
}

async function assertDirectoryIdentityGuard(guard: AsyncDirectoryGuard): Promise<void> {
  try {
    await assertAsyncDirectoryGuard(guard);
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw new ArchiveSecurityError(
        "destination-symlink-traversal",
        "archive destination changed during extraction",
      );
    }
    throw err;
  }
}

export async function prepareArchiveDestinationDir(destDir: string): Promise<string> {
  const stat = await fs.lstat(destDir);
  if (stat.isSymbolicLink()) {
    throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
  }
  if (!stat.isDirectory()) {
    throw new ArchiveSecurityError(
      "destination-not-directory",
      "archive destination is not a directory",
    );
  }
  const realPath = await fs.realpath(destDir);
  const realStat = await fs.stat(realPath);
  const postStat = await fs.lstat(destDir);
  if (
    realStat.dev !== stat.dev ||
    realStat.ino !== stat.ino ||
    postStat.isSymbolicLink() ||
    !postStat.isDirectory() ||
    postStat.dev !== stat.dev ||
    postStat.ino !== stat.ino
  ) {
    throw new ArchiveSecurityError(
      "destination-symlink-traversal",
      "archive destination changed during extraction",
    );
  }
  return realPath;
}

async function assertNoSymlinkTraversal(params: {
  rootDir: string;
  relPath: string;
  originalPath: string;
}): Promise<void> {
  const parts = params.relPath.split(/[\\/]+/).filter(Boolean);
  let current = path.resolve(params.rootDir);
  for (const part of parts) {
    current = path.join(current, part);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (isNotFoundPathError(err)) {
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw symlinkTraversalError(params.originalPath);
    }
  }
}

async function assertResolvedInsideDestination(params: {
  destinationRealDir: string;
  targetPath: string;
  originalPath: string;
}): Promise<void> {
  let resolved: string;
  try {
    resolved = await fs.realpath(params.targetPath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (!isPathInside(params.destinationRealDir, resolved)) {
    throw symlinkTraversalError(params.originalPath);
  }
}

async function mkdirArchiveOutput(params: {
  targetRoot: { mkdir(relativePath: string): Promise<void> };
  relativePath: string;
  originalPath: string;
}): Promise<void> {
  try {
    await params.targetRoot.mkdir(params.relativePath);
  } catch (error) {
    if (error instanceof FsSafeError) {
      throw symlinkTraversalError(params.originalPath);
    }
    throw error;
  }
}

export async function prepareArchiveOutputPath(params: {
  destinationDir: string;
  destinationRealDir: string;
  relPath: string;
  outPath: string;
  originalPath: string;
  isDirectory: boolean;
}): Promise<void> {
  const targetRoot = await root(params.destinationRealDir);
  const destinationGuard = await createDirectoryIdentityGuard(params.destinationRealDir);
  const relPath = params.relPath.split(path.sep).join(path.posix.sep);
  await assertNoSymlinkTraversal({
    rootDir: params.destinationDir,
    relPath,
    originalPath: params.originalPath,
  });

  if (params.isDirectory) {
    await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("mkdir", params.outPath);
    await assertDirectoryIdentityGuard(destinationGuard);
    await mkdirArchiveOutput({ targetRoot, relativePath: relPath, originalPath: params.originalPath });
    await assertDirectoryIdentityGuard(destinationGuard);
    await assertResolvedInsideDestination({
      destinationRealDir: params.destinationRealDir,
      targetPath: params.outPath,
      originalPath: params.originalPath,
    });
    return;
  }

  const parentRel = path.posix.dirname(relPath);
  if (parentRel !== ".") {
    await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("mkdir", path.dirname(params.outPath));
    await assertDirectoryIdentityGuard(destinationGuard);
    await mkdirArchiveOutput({
      targetRoot,
      relativePath: parentRel,
      originalPath: params.originalPath,
    });
    await assertDirectoryIdentityGuard(destinationGuard);
  }
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: path.dirname(params.outPath),
    originalPath: params.originalPath,
  });
}

async function chmodInsideDestinationBestEffort(params: {
  destinationRealDir: string;
  destinationPath: string;
  mode: number;
  originalPath: string;
}): Promise<void> {
  await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("chmod", params.destinationPath);
  const destinationGuard = await createDirectoryIdentityGuard(params.destinationRealDir);
  await assertDirectoryIdentityGuard(destinationGuard);
  const noFollowFlag =
    process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants
      ? fsSync.constants.O_NOFOLLOW
      : 0;
  const handle = await fs
    .open(params.destinationPath, fsSync.constants.O_RDONLY | noFollowFlag)
    .catch(() => null);
  if (!handle) {
    const stat = await fs.lstat(params.destinationPath).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw symlinkTraversalError(params.originalPath);
    }
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() && !stat.isFile()) {
      return;
    }
    const realPath = await resolveOpenedFileRealPathForHandle(handle, params.destinationPath);
    if (!isPathInside(params.destinationRealDir, realPath)) {
      throw symlinkTraversalError(params.originalPath);
    }
    await handle.chmod(params.mode).catch(() => undefined);
    await assertDirectoryIdentityGuard(destinationGuard);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function applyStagedEntryMode(params: {
  destinationRealDir: string;
  relPath: string;
  mode: number;
  originalPath: string;
}): Promise<void> {
  const destinationPath = path.join(params.destinationRealDir, params.relPath);
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: destinationPath,
    originalPath: params.originalPath,
  });
  if (params.mode !== 0) {
    await chmodInsideDestinationBestEffort({
      destinationRealDir: params.destinationRealDir,
      destinationPath,
      mode: params.mode,
      originalPath: params.originalPath,
    });
  }
}

async function assertExtractedFileHasNoHardlinkAlias(params: {
  destinationRealDir: string;
  relPath: string;
  originalPath: string;
}): Promise<void> {
  const destinationPath = path.join(params.destinationRealDir, params.relPath);
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: destinationPath,
    originalPath: params.originalPath,
  });
  const stat = await fs.lstat(destinationPath);
  if (stat.isFile() && stat.nlink > 1) {
    throw symlinkTraversalError(params.originalPath);
  }
}

async function removeExtractedDestinationFile(params: {
  destinationRealDir: string;
  relPath: string;
}): Promise<void> {
  const destinationPath = path.join(params.destinationRealDir, params.relPath);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(destinationPath);
  } catch {
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  let resolved: string;
  try {
    resolved = await fs.realpath(destinationPath);
  } catch {
    return;
  }
  if (!isPathInside(params.destinationRealDir, resolved)) {
    return;
  }
  const targetRoot = await root(params.destinationRealDir);
  await targetRoot.remove(params.relPath).catch(() => undefined);
}

function assertSafeArchiveStagingPrefix(prefix: string): string {
  if (
    !prefix ||
    prefix === "." ||
    prefix === ".." ||
    prefix.includes("/") ||
    prefix.includes("\\") ||
    path.basename(prefix) !== prefix
  ) {
    throw new Error("archive staging prefix must be a single path segment");
  }
  return prefix;
}

export async function withStagedArchiveDestination<T>(params: {
  destinationRealDir: string;
  stagingDirPrefix?: string;
  run: (stagingDir: string) => Promise<T>;
}): Promise<T> {
  const stagingRoot = resolveSecureTempRoot({
    fallbackPrefix: "fs-safe-archive",
    unsafeFallbackLabel: "archive staging temp dir",
    warn: () => undefined,
  });
  if (isPathInside(params.destinationRealDir, stagingRoot)) {
    throw new Error(`archive staging root must be outside destination: ${stagingRoot}`);
  }
  const stagingPrefix = assertSafeArchiveStagingPrefix(
    params.stagingDirPrefix ?? "fs-safe-archive-",
  );
  const stagingDir = await fs.mkdtemp(
    path.join(stagingRoot, stagingPrefix),
  );
  const stagingGuard = await createDirectoryIdentityGuard(stagingDir);
  try {
    await fs.chmod(stagingDir, ARCHIVE_STAGING_MODE).catch(() => undefined);
    await assertDirectoryIdentityGuard(stagingGuard);
    return await params.run(stagingDir);
  } finally {
    try {
      await assertDirectoryIdentityGuard(stagingGuard);
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    } catch {
      // The staging path identity changed; deleting by name could target data
      // outside the private temp tree, so fail closed and leave it for OS cleanup.
    }
  }
}

export async function mergeExtractedTreeIntoDestination(params: {
  sourceDir: string;
  destinationDir: string;
  destinationRealDir: string;
}): Promise<void> {
  const targetRoot = await root(params.destinationRealDir);
  const sourceRootGuard = await createDirectoryIdentityGuard(params.sourceDir);
  const sourceRootReal = sourceRootGuard.realPath;
  const walk = async (currentSourceDir: string): Promise<void> => {
    await assertDirectoryIdentityGuard(sourceRootGuard);
    const entries = await fs.readdir(currentSourceDir, { withFileTypes: true });
    for (const entry of entries) {
      await assertDirectoryIdentityGuard(sourceRootGuard);
      const sourcePath = path.join(currentSourceDir, entry.name);
      const relPath = path.relative(params.sourceDir, sourcePath);
      const originalPath = relPath.split(path.sep).join("/");
      const destinationPath = path.join(params.destinationDir, relPath);
      const sourceStat = await fs.lstat(sourcePath);
      if (sourceStat.isSymbolicLink()) {
        throw symlinkTraversalError(originalPath);
      }
      const sourceReal = await fs.realpath(sourcePath);
      if (!isPathInside(sourceRootReal, sourceReal)) {
        throw symlinkTraversalError(originalPath);
      }

      if (sourceStat.isDirectory()) {
        await prepareArchiveOutputPath({
          destinationDir: params.destinationDir,
          destinationRealDir: params.destinationRealDir,
          relPath,
          outPath: destinationPath,
          originalPath,
          isDirectory: true,
        });
        await walk(sourcePath);
        await applyStagedEntryMode({
          destinationRealDir: params.destinationRealDir,
          relPath,
          mode: sourceStat.mode & 0o777,
          originalPath,
        });
        continue;
      }

      if (!sourceStat.isFile()) {
        throw new Error(
          `archive staging contains unsupported entry: ${formatErrorDetail(originalPath)}`,
        );
      }

      await prepareArchiveOutputPath({
        destinationDir: params.destinationDir,
        destinationRealDir: params.destinationRealDir,
        relPath,
        outPath: destinationPath,
        originalPath,
        isDirectory: false,
      });
      try {
        await targetRoot.copyIn(relPath, sourcePath, { mkdir: true });
        await assertExtractedFileHasNoHardlinkAlias({
          destinationRealDir: params.destinationRealDir,
          relPath,
          originalPath,
        });
        await applyStagedEntryMode({
          destinationRealDir: params.destinationRealDir,
          relPath,
          mode: sourceStat.mode & 0o777,
          originalPath,
        });
      } catch (err) {
        await removeExtractedDestinationFile({
          destinationRealDir: params.destinationRealDir,
          relPath,
        });
        if (err instanceof FsSafeError && (err.code === "hardlink" || err.code === "path-alias")) {
          throw symlinkTraversalError(originalPath);
        }
        throw err;
      }
    }
  };

  await walk(params.sourceDir);
}

export function createArchiveSymlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return symlinkTraversalError(originalPath);
}
