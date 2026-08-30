import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { sanitizeUntrustedFileName } from "./filename.js";
import { applyDirectoryMode } from "./replace-file-descriptor.js";
import { root } from "./root.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { writeCallbackSibling } from "./sibling-staged-file.js";
import { tempFile } from "./temp-target.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export type WriteSiblingTempFileOptions<T> = {
  dir: string;
  writeTemp: (tempPath: string) => Promise<T>;
  resolveFinalPath: (result: T) => string;
  tempPrefix?: string;
  dirMode?: number;
  chmodDir?: boolean;
  /** Final file mode; defaults to 0o600. Applied through the retained descriptor. */
  mode?: number;
  /** Sync the staged descriptor before rename; defaults to true. */
  syncTempFile?: boolean;
  /** Best-effort parent directory sync after rename; defaults to true. */
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

export async function writeSiblingTempFile<T>(
  options: WriteSiblingTempFileOptions<T>,
): Promise<WriteSiblingTempFileResult<T>> {
  const dir = path.resolve(options.dir);
  await fs.mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  if (options.chmodDir !== false) {
    await applyDirectoryMode({ fsModule: fs, dirPath: dir, mode: options.dirMode ?? 0o700 });
  }
  return await writeCallbackSibling({
    tempPath: buildTempPath(dir, options.tempPrefix),
    write: options.writeTemp,
    resolveFinalPath: options.resolveFinalPath,
    mode: options.mode ?? 0o600,
    syncTempFile: options.syncTempFile !== false,
    syncParentDir: options.syncParentDir !== false,
  });
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
  const workspace = await tempFile({
    rootDir: resolveSecureTempRoot({
      fallbackPrefix: "fs-safe-output",
      unsafeFallbackLabel: "sibling temp output dir",
      warn: () => undefined,
    }),
    prefix: "fs-safe-output",
  });
  try {
    const tempPath = buildSiblingTempPath({
      targetPath: path.join(workspace.dir, path.basename(targetPath)),
      fallbackFileName: params.fallbackFileName ?? "output.bin",
      tempPrefix: params.tempPrefix ?? ".fs-safe-output-",
    });
    await getFsSafeTestHooks()?.beforeSiblingTempWrite?.(tempPath);
    await params.writeTemp(tempPath);
    await assertAsyncDirectoryGuard(rootGuard);
    const targetRoot = await root(rootDir);
    await targetRoot.copyIn(relativeTargetPath, tempPath, { mkdir: false });
    await assertAsyncDirectoryGuard(rootGuard);
  } finally {
    await workspace.cleanup();
  }
}
