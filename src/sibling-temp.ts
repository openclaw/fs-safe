import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { fitFileNameToPortableComponent, sanitizeUntrustedFileName } from "./filename.js";
import { applyDirectoryMode } from "./replace-file-descriptor.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { root } from "./root.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { resolveCallbackTempPath, writeCallbackSibling } from "./sibling-staged-file.js";
import { tempFile } from "./temp-target.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type WriteSiblingTempFileOptions<T> = {
  dir: string;
  writeTemp: (tempPath: string) => Promise<T>;
  /** Own a private sibling workspace before invoking the producer. */
  producerIsolation?: "private-directory";
  resolveFinalPath: (result: T) => string;
  tempPrefix?: string;
  dirMode?: number;
  chmodDir?: boolean;
  /** Final file mode; omitted preserves the producer's mode. Applied through the retained descriptor. */
  mode?: number;
  /** Sync the staged descriptor before rename; defaults to false. */
  syncTempFile?: boolean;
  /** Best-effort parent directory sync after rename; defaults to false. */
  syncParentDir?: boolean;
};

export type WriteSiblingTempFileResult<T> = {
  filePath: string;
  result: T;
};

function buildTempName(tempPrefix?: string): string {
  const safePrefix = assertSafePathPrefix(tempPrefix ?? ".fs-safe-stream", {
    label: "sibling temp prefix",
  });
  return `${safePrefix}.${process.pid}.${randomUUID()}.tmp`;
}

export async function writeSiblingTempFile<T>(
  options: WriteSiblingTempFileOptions<T>,
): Promise<WriteSiblingTempFileResult<T>> {
  const dirInput = options.dir;
  assertNoWindowsPathAlias(dirInput, "filesystem", "sibling temp directory uses a Windows filesystem namespace alias");
  const dir = resolvePathPreservingWindowsRoot(dirInput);
  assertNoWindowsPathAlias(dir, "filesystem", "sibling temp directory uses a Windows filesystem namespace alias");
  const producerIsolation = options.producerIsolation;
  const dirMode = options.dirMode ?? 0o700;
  const chmodDir = options.chmodDir !== false;
  const tempPrefix = options.tempPrefix;
  const writeTemp = options.writeTemp;
  const resolveFinalPath = options.resolveFinalPath;
  const mode = options.mode;
  const syncTempFile = options.syncTempFile === true;
  const syncParentDir = options.syncParentDir === true;
  await fs.mkdir(recursiveMkdirPath(dir), { recursive: true, mode: dirMode });
  if (chmodDir) {
    await applyDirectoryMode({
      fsModule: fs,
      dirPath: dir,
      mode: dirMode,
      ignoreChmodError: true,
    });
  }
  return await writeCallbackSibling({
    tempDir: dir,
    tempName: buildTempName(tempPrefix),
    write: writeTemp,
    producerIsolation,
    resolveFinalPath,
    mode,
    ignoreModeError: true,
    syncTempFile,
    syncParentDir,
  });
}

function buildSiblingTempName(params: {
  targetPath: string;
  fallbackFileName: string;
  tempPrefix: string;
}): string {
  const id = crypto.randomUUID();
  const safePrefix = assertSafePathPrefix(params.tempPrefix, {
    label: "sibling temp prefix",
  });
  const prefix = `${safePrefix}${id}-`;
  const suffix = ".part";
  const safeTail = fitFileNameToPortableComponent({
    prefix,
    fileName: sanitizeUntrustedFileName(
      path.basename(params.targetPath),
      params.fallbackFileName,
    ),
    suffix,
  });
  return `${prefix}${safeTail}${suffix}`;
}

export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
  fallbackFileName?: string;
  tempPrefix?: string;
}): Promise<void> {
  const rootDirInput = params.rootDir;
  const targetPathInput = params.targetPath;
  assertNoWindowsPathAlias(rootDirInput, "filesystem", "sibling temp root uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(targetPathInput, "filesystem", "sibling temp target uses a Windows filesystem namespace alias");
  let rootDir: string;
  try { rootDir = realpathSync.native(resolvePathPreservingWindowsRoot(rootDirInput)); }
  catch { rootDir = resolvePathPreservingWindowsRoot(rootDirInput); }
  assertNoWindowsPathAlias(rootDir, "filesystem", "sibling temp root uses a Windows filesystem namespace alias");
  const requestedTargetPath = path.resolve(targetPathInput);
  assertNoWindowsPathAlias(requestedTargetPath, "filesystem", "sibling temp target uses a Windows filesystem namespace alias");
  let targetPath: string;
  try {
    const realDir = realpathSync.native(path.dirname(requestedTargetPath));
    targetPath = path.join(realDir, path.basename(requestedTargetPath));
  } catch {
    targetPath = requestedTargetPath;
  }
  assertNoWindowsPathAlias(targetPath, "filesystem", "sibling temp target uses a Windows filesystem namespace alias");
  const relativeTargetPath = path.relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Target path is outside the allowed root");
  }
  const writeTemp = params.writeTemp;
  const fallbackFileName = params.fallbackFileName;
  const tempPrefix = params.tempPrefix;
  const rootGuard = await createAsyncDirectoryGuard(rootDir);
  const workspace = await tempFile({
    rootDir: resolveSecureTempRoot({
      fallbackPrefix: "fs-safe-output",
      unsafeFallbackLabel: "sibling temp output dir",
      warn: () => undefined,
    }),
    prefix: "fs-safe-output",
  });
  assertNoWindowsPathAlias(workspace.dir, "filesystem", "sibling temp workspace uses a Windows filesystem namespace alias");
  try {
    const tempName = buildSiblingTempName({
      targetPath: path.join(workspace.dir, path.basename(targetPath)),
      fallbackFileName: fallbackFileName ?? "output.bin",
      tempPrefix: tempPrefix ?? ".fs-safe-output-",
    });
    const tempPath = resolveCallbackTempPath(workspace.dir, tempName);
    await getFsSafeTestHooks()?.beforeSiblingTempWrite?.(tempPath);
    await Reflect.apply(writeTemp, params, [tempPath]);
    await assertAsyncDirectoryGuard(rootGuard);
    const targetRoot = await root(rootDir);
    await targetRoot.copyIn(relativeTargetPath, tempPath, { mkdir: false });
    await assertAsyncDirectoryGuard(rootGuard);
  } finally {
    await workspace.cleanup();
  }
}
