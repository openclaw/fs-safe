import fsSync, { type BigIntStats } from "node:fs";
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
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";

const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";
const ARCHIVE_STAGING_MODE = 0o700;

export type ArchiveDirectoryGuard = AsyncDirectoryGuard<BigIntStats>;

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

export async function createDirectoryIdentityGuard(dir: string): Promise<ArchiveDirectoryGuard> {
  assertNoWindowsPathAlias(dir);
  try {
    const guard = await createAsyncDirectoryGuard(dir, { bigint: true });
    assertNoWindowsPathAlias(guard.realPath);
    return guard;
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "not-file") {
      throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
    }
    throw err;
  }
}

export async function assertDirectoryIdentityGuard(guard: ArchiveDirectoryGuard): Promise<void> {
  try {
    await assertAsyncDirectoryGuard(guard);
  } catch (err) {
    if (err instanceof FsSafeError || isNotFoundPathError(err)) {
      throw new ArchiveSecurityError(
        "destination-symlink-traversal",
        "archive destination changed during extraction",
      );
    }
    throw err;
  }
}

export async function prepareArchiveDestinationGuard(destDir: string): Promise<ArchiveDirectoryGuard> {
  assertNoWindowsPathAlias(destDir);
  let stat: BigIntStats;
  try {
    stat = inspectFileIdentitySync(() => {
      const observed = fsSync.lstatSync(destDir, { bigint: true });
      if (observed.isSymbolicLink()) {
        throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
      }
      if (!observed.isDirectory()) {
        throw new ArchiveSecurityError(
          "destination-not-directory",
          "archive destination is not a directory",
        );
      }
      return observed;
    });
  } catch (err) {
    if (err instanceof ArchiveSecurityError) throw err;
    if (err instanceof FsSafeError) {
      throw new ArchiveSecurityError(
        "destination-symlink-traversal",
        "archive destination changed during extraction",
      );
    }
    throw err;
  }
  const realPath = realpathSync.native(destDir);
  assertNoWindowsPathAlias(realPath);
  const guard: ArchiveDirectoryGuard = { dir: destDir, realPath, stat };
  try {
    inspectFileIdentitySync(() => fsSync.statSync(realPath, { bigint: true }), stat);
    inspectFileIdentitySync(() => fsSync.lstatSync(destDir, { bigint: true }), stat);
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw new ArchiveSecurityError(
        "destination-symlink-traversal",
        "archive destination changed during extraction",
      );
    }
    throw err;
  }
  return guard;
}

export async function prepareArchiveDestinationDir(destDir: string): Promise<string> {
  return (await prepareArchiveDestinationGuard(destDir)).realPath;
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
      stat = fsSync.lstatSync(current);
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
  const destinationRealDir = params.destinationRealDir;
  const targetPath = params.targetPath;
  const originalPath = params.originalPath;
  assertNoWindowsPathAlias(destinationRealDir);
  assertNoWindowsPathAlias(targetPath);
  let resolved: string;
  try {
    resolved = realpathSync.native(targetPath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  assertNoWindowsPathAlias(resolved);
  if (!isPathInside(destinationRealDir, resolved)) {
    throw symlinkTraversalError(originalPath);
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

function ownArchiveOutputPathParams(params: ArchiveOutputPathParams): ArchiveOutputPathParams {
  const deadline = params.deadline;
  checkExtractionDeadline(deadline);
  const destinationDir = params.destinationDir;
  const destinationRealDir = params.destinationRealDir;
  const relPath = params.relPath;
  const outPath = params.outPath;
  const originalPath = params.originalPath;
  const isDirectory = params.isDirectory;
  assertNoWindowsPathAlias(destinationDir);
  assertNoWindowsPathAlias(destinationRealDir);
  assertNoWindowsPathAlias(relPath, "relative");
  assertNoWindowsPathAlias(outPath);
  return { destinationDir, destinationRealDir, relPath, outPath, originalPath, isDirectory, deadline };
}

export async function prepareArchiveOutputPath(params: ArchiveOutputPathParams): Promise<void> {
  await prepareOutputPath(ownArchiveOutputPathParams(params));
}

export async function preparePrivateArchiveOutputPath(
  params: ArchiveOutputPathParams, assertGuards?: () => Promise<void>,
  destinationGuard?: ArchiveDirectoryGuard,
): Promise<void> {
  await prepareOutputPath(
    ownArchiveOutputPathParams(params),
    assertGuards,
    true,
    destinationGuard,
  );
}

async function prepareOutputPath(
  params: ArchiveOutputPathParams, assertGuards?: () => Promise<void>, privateWorkingMode = false,
  existingDestinationGuard?: ArchiveDirectoryGuard,
): Promise<void> {
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
          await assertOutputGuards();
          checkExtractionDeadline(params.deadline);
        },
      });
    },
  } : await root(params.destinationRealDir);
  checkExtractionDeadline(params.deadline);
  const destinationGuard = existingDestinationGuard ?? await createDirectoryIdentityGuard(params.destinationRealDir);
  const assertOutputGuards = async () => {
    // The merge's callback verifies this same original destination guard.
    if (existingDestinationGuard && assertGuards) await assertGuards();
    else {
      await assertDirectoryIdentityGuard(destinationGuard);
      checkExtractionDeadline(params.deadline);
      await assertGuards?.();
    }
  };
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
      await assertOutputGuards();
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
      await assertOutputGuards();
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
  assertNoWindowsPathAlias(prefix, "relative");
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
  const destinationRealDir = params.destinationRealDir;
  assertNoWindowsPathAlias(destinationRealDir);
  const stagingRoot = resolveSecureTempRoot({
    fallbackPrefix: "fs-safe-archive",
    unsafeFallbackLabel: "archive staging temp dir",
    warn: () => undefined,
  });
  assertNoWindowsPathAlias(stagingRoot);
  if (isPathInside(destinationRealDir, stagingRoot)) {
    throw new Error(`archive staging root must be outside destination: ${stagingRoot}`);
  }
  const stagingDirPrefix = params.stagingDirPrefix;
  const stagingPrefix = assertSafeArchiveStagingPrefix(
    stagingDirPrefix ?? "fs-safe-archive-",
  );
  const stagingPathPrefix = path.join(stagingRoot, stagingPrefix);
  assertNoWindowsPathAlias(stagingPathPrefix);
  const stagingDir = await fs.mkdtemp(stagingPathPrefix);
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
