import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  createAsyncDirectoryGuard,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import {
  ownExtractionDestinationMutation,
  type ExtractionDeadline,
} from "./archive-deadline.js";
import {
  ArchiveSecurityError,
  type ArchiveSecurityErrorCode,
} from "./archive-errors.js";
import { FsSafeError } from "./errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { root } from "./root.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { expandRelativePathWithHome } from "./root-context.js";
import { resolveRootPath } from "./root-path.js";

const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
const ARCHIVE_STAGING_MODE = 0o700;

function checkExtractionDeadline(deadline?: ExtractionDeadline): void {
  deadline?.check();
}

export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-errors.js";

function symlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return new ArchiveSecurityError(
    "destination-symlink-traversal",
    `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${formatErrorDetail(originalPath)}`,
  );
}

export async function createDirectoryIdentityGuard(dir: string): Promise<AsyncDirectoryGuard> {
  try {
    return await createAsyncDirectoryGuard(dir);
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "not-file") {
      throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
    }
    throw err;
  }
}

export async function assertDirectoryIdentityGuard(guard: AsyncDirectoryGuard): Promise<void> {
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

export async function assertResolvedInsideDestination(params: {
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

type ArchiveOutputPathParams = {
  destinationDir: string;
  destinationRealDir: string;
  relPath: string;
  outPath: string;
  originalPath: string;
  isDirectory: boolean;
  deadline?: ExtractionDeadline;
};

export async function prepareArchiveOutputPath(params: ArchiveOutputPathParams): Promise<void> {
  await prepareOutputPath(params);
}

export async function preparePrivateArchiveOutputPath(
  params: ArchiveOutputPathParams, assertGuards?: () => Promise<void>,
): Promise<void> {
  await prepareOutputPath(params, assertGuards, true);
}

async function prepareOutputPath(
  params: ArchiveOutputPathParams, assertGuards?: () => Promise<void>, privateWorkingMode = false,
): Promise<void> {
  checkExtractionDeadline(params.deadline);
  const targetRoot = privateWorkingMode ? {
    async mkdir(relativePath: string) {
      // Retain Root.mkdir's strict alias admission before the shared traversal,
      // while selecting private creation modes without adding a public option.
      const resolved = await resolveRootPath({
        absolutePath: path.resolve(params.destinationRealDir, await expandRelativePathWithHome(relativePath)),
        rootPath: params.destinationRealDir,
        rootCanonicalPath: params.destinationRealDir,
        boundaryLabel: "archive destination",
        rejectSymlinks: true,
      });
      checkExtractionDeadline(params.deadline);
      await mkdirPathComponentsWithGuards({
        rootReal: params.destinationRealDir,
        targetPath: resolved.canonicalPath,
        mode: 0o700,
        rejectSymlinks: true,
        beforeComponent: async () => {
          await assertDirectoryIdentityGuard(destinationGuard);
          checkExtractionDeadline(params.deadline);
          await assertGuards?.();
          checkExtractionDeadline(params.deadline);
        },
      });
    },
  } : await root(params.destinationRealDir);
  checkExtractionDeadline(params.deadline);
  const destinationGuard = await createDirectoryIdentityGuard(params.destinationRealDir);
  checkExtractionDeadline(params.deadline);
  const relPath = params.relPath.split(path.sep).join(path.posix.sep);
  await assertNoSymlinkTraversal({
    rootDir: params.destinationDir,
    relPath,
    originalPath: params.originalPath,
  });
  checkExtractionDeadline(params.deadline);

  if (params.isDirectory) {
    await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("mkdir", params.outPath);
    checkExtractionDeadline(params.deadline);
    await ownExtractionDestinationMutation(params.deadline, async () => {
      await assertDirectoryIdentityGuard(destinationGuard);
      checkExtractionDeadline(params.deadline);
      await assertGuards?.();
      checkExtractionDeadline(params.deadline);
      await mkdirArchiveOutput({
        targetRoot,
        relativePath: relPath,
        originalPath: params.originalPath,
      });
      checkExtractionDeadline(params.deadline);
      await assertDirectoryIdentityGuard(destinationGuard);
      checkExtractionDeadline(params.deadline);
      await assertResolvedInsideDestination({
        destinationRealDir: params.destinationRealDir,
        targetPath: params.outPath,
        originalPath: params.originalPath,
      });
      checkExtractionDeadline(params.deadline);
    });
    return;
  }

  const parentRel = path.posix.dirname(relPath);
  if (parentRel !== ".") {
    await getFsSafeTestHooks()?.beforeArchiveOutputMutation?.("mkdir", path.dirname(params.outPath));
    checkExtractionDeadline(params.deadline);
    await ownExtractionDestinationMutation(params.deadline, async () => {
      await assertDirectoryIdentityGuard(destinationGuard);
      checkExtractionDeadline(params.deadline);
      await assertGuards?.();
      checkExtractionDeadline(params.deadline);
      await mkdirArchiveOutput({
        targetRoot,
        relativePath: parentRel,
        originalPath: params.originalPath,
      });
      checkExtractionDeadline(params.deadline);
      await assertDirectoryIdentityGuard(destinationGuard);
      checkExtractionDeadline(params.deadline);
    });
  }
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: path.dirname(params.outPath),
    originalPath: params.originalPath,
  });
  checkExtractionDeadline(params.deadline);
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

export { mergeExtractedTreeIntoDestination } from "./archive-merge.js";

export function createArchiveSymlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return symlinkTraversalError(originalPath);
}
