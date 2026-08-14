import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { sanitizeUntrustedFileName } from "./filename.js";
import { root } from "./root.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { serializePathWrite } from "./write-queue.js";

export type WriteSiblingTempFileOptions<T> = {
  dir: string;
  writeTemp: (tempPath: string) => Promise<T>;
  resolveFinalPath: (result: T) => string;
  tempPrefix?: string;
  dirMode?: number;
  chmodDir?: boolean;
  mode?: number;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
};

export type WriteSiblingTempFileResult<T> = {
  filePath: string;
  result: T;
};

function buildTempPath(dir: string, tempPrefix?: string): string {
  const safePrefix = assertSafePathPrefix(tempPrefix ?? ".fs-safe-stream", {
    label: "sibling temp prefix",
  });
  return path.join(dir, `${safePrefix}.${process.pid}.${randomUUID()}.tmp`);
}

async function syncFileBestEffort(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function assertFinalPathIsSibling(dir: string, filePath: string): void {
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  if (path.dirname(resolvedFile) !== resolvedDir) {
    throw new Error("Final path must be in the sibling temp directory.");
  }
}

export async function writeSiblingTempFile<T>(
  options: WriteSiblingTempFileOptions<T>,
): Promise<WriteSiblingTempFileResult<T>> {
  const dir = path.resolve(options.dir);
  await fs.mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  if (options.chmodDir !== false) {
    await fs.chmod(dir, options.dirMode ?? 0o700).catch(() => undefined);
  }
  const dirGuard = await createAsyncDirectoryGuard(dir);
  const tempPath = buildTempPath(dir, options.tempPrefix);
  const unregisterTempPath = registerTempPathForExit(tempPath);
  let tempExists = false;
  try {
    tempExists = true;
    const result = await options.writeTemp(tempPath);
    unregisterTempPath.setIdentity(await fs.lstat(tempPath, { bigint: true }));
    if (options.mode !== undefined) {
      await fs.chmod(tempPath, options.mode).catch(() => undefined);
    }
    if (options.syncTempFile) {
      await syncFileBestEffort(tempPath);
    }
    const filePath = path.resolve(options.resolveFinalPath(result));
    assertFinalPathIsSibling(dir, filePath);
    await serializePathWrite(filePath, async () => {
      await withAsyncDirectoryGuards([dirGuard], async () => {
        await fs.rename(tempPath, filePath);
      });
      tempExists = false;
      unregisterTempPath();
      if (options.mode !== undefined) {
        await fs.chmod(filePath, options.mode).catch(() => undefined);
      }
      if (options.syncParentDir) {
        await syncDirectoryBestEffort(dir);
      }
    });
    return { filePath, result };
  } finally {
    if (tempExists) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    unregisterTempPath();
  }
}

function buildSiblingTempPath(params: {
  targetPath: string;
  fallbackFileName: string;
  tempPrefix: string;
}): string {
  const id = crypto.randomUUID();
  const safePrefix = assertSafePathPrefix(params.tempPrefix, {
    label: "sibling temp prefix",
  });
  const safeTail = sanitizeUntrustedFileName(
    path.basename(params.targetPath),
    params.fallbackFileName,
  );
  return path.join(path.dirname(params.targetPath), `${safePrefix}${id}-${safeTail}.part`);
}

export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
  fallbackFileName?: string;
  tempPrefix?: string;
}): Promise<void> {
  const rootDir = await fs
    .realpath(path.resolve(params.rootDir))
    .catch(() => path.resolve(params.rootDir));
  const requestedTargetPath = path.resolve(params.targetPath);
  const targetPath = await fs
    .realpath(path.dirname(requestedTargetPath))
    .then((realDir) => path.join(realDir, path.basename(requestedTargetPath)))
    .catch(() => requestedTargetPath);
  const relativeTargetPath = path.relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Target path is outside the allowed root");
  }
  const rootGuard = await createAsyncDirectoryGuard(rootDir);
  const tempDir = await fs.mkdtemp(
    path.join(
      resolveSecureTempRoot({
        fallbackPrefix: "fs-safe-output",
        unsafeFallbackLabel: "sibling temp output dir",
        warn: () => undefined,
      }),
      "fs-safe-output-",
    ),
  );
  const tempPath = buildSiblingTempPath({
    targetPath: path.join(tempDir, path.basename(targetPath)),
    fallbackFileName: params.fallbackFileName ?? "output.bin",
    tempPrefix: params.tempPrefix ?? ".fs-safe-output-",
  });
  const unregisterTempPath = registerTempPathForExit(tempDir, { recursive: true });
  try {
    await getFsSafeTestHooks()?.beforeSiblingTempWrite?.(tempPath);
    await params.writeTemp(tempPath);
    await assertAsyncDirectoryGuard(rootGuard);
    const targetRoot = await root(rootDir);
    await targetRoot.copyIn(relativeTargetPath, tempPath, { mkdir: false });
    await assertAsyncDirectoryGuard(rootGuard);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    unregisterTempPath();
  }
}
