import { randomUUID } from "node:crypto";
import { writeCallbackSibling } from "./sibling-staged-file.js";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { fitFileNameToPortableComponent, sanitizeUntrustedFileName } from "./filename.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
import { tempFile } from "./temp-target.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type ExternalFileWriteOptions<T = void> = {
  rootDir: string;
  path: string;
  write: (filePath: string) => Promise<T>;
  maxBytes?: number;
  mode?: number;
  staging?: "workspace" | "sibling";
  /** Isolate sibling producers; workspace staging is already private. */
  producerIsolation?: "private-directory";
  fallbackFileName?: string;
};

export type ExternalFileWriteResult<T = void> = {
  path: string;
  result: T;
};

const NON_PORTABLE_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u;

function tempFileNameForTarget(targetPath: string, fallbackFileName?: string): string {
  const fallback = sanitizeUntrustedFileName(fallbackFileName ?? "output.bin", "output.bin");
  return sanitizeUntrustedFileName(path.basename(targetPath), fallback);
}

function sanitizedTargetPath(targetPath: string, fallbackFileName?: string): string {
  const basename = path.basename(targetPath);
  if (!NON_PORTABLE_FILE_NAME_CHARACTERS.test(basename)) {
    return targetPath;
  }
  const sanitized = tempFileNameForTarget(targetPath, fallbackFileName);
  return sanitized === basename ? targetPath : path.join(path.dirname(targetPath), sanitized);
}

function ensureTrailingSep(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function toRootPathInput(params: {
  rootDir: string;
  rootReal: string;
  targetPath: string;
}): string {
  if (!path.isAbsolute(params.targetPath)) {
    return params.targetPath;
  }

  const absoluteTarget = path.resolve(params.targetPath);
  const rootDir = path.resolve(params.rootDir);
  if (isPathInside(ensureTrailingSep(rootDir), absoluteTarget)) {
    return path.relative(rootDir, absoluteTarget);
  }
  if (isPathInside(ensureTrailingSep(params.rootReal), absoluteTarget)) {
    return path.relative(params.rootReal, absoluteTarget);
  }
  return params.targetPath;
}

function assertFileTargetPath(targetPath: string): void {
  const basename = path.basename(targetPath);
  if (
    !targetPath ||
    targetPath === "." ||
    targetPath.endsWith("/") ||
    targetPath.endsWith("\\") ||
    !basename ||
    basename === "." ||
    basename === ".."
  ) {
    throw new FsSafeError("invalid-path", "target path must name a file");
  }
}

export async function writeExternalFileWithinRoot<T = void>(
  options: ExternalFileWriteOptions<T>,
): Promise<ExternalFileWriteResult<T>> {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const rootDir = options.rootDir;
  assertNoWindowsPathAlias(rootDir, "filesystem", "output root uses a Windows filesystem namespace alias");
  const requestedTargetPath = options.path;
  assertNoWindowsPathAlias(
    path.dirname(requestedTargetPath),
    "filesystem",
    "output target parent uses a Windows filesystem namespace alias",
  );
  const producerIsolation = options.producerIsolation;
  const write = options.write;
  const mode = options.mode;
  const staging = options.staging;
  const fallbackFileName = options.fallbackFileName;
  const targetRoot = await root(rootDir);
  if (requestedTargetPath.length === 0) {
    throw new FsSafeError("invalid-path", "target path is required");
  }
  assertFileTargetPath(requestedTargetPath);
  const rawTargetPath = toRootPathInput({
    rootDir: targetRoot.rootDir,
    rootReal: targetRoot.rootReal,
    targetPath: requestedTargetPath,
  });
  assertFileTargetPath(rawTargetPath);
  const targetPath = sanitizedTargetPath(rawTargetPath, fallbackFileName);
  assertNoWindowsPathAlias(targetPath, "filesystem", "output target uses a Windows filesystem namespace alias");
  const finalPath = await targetRoot.resolve(targetPath);
  assertNoWindowsPathAlias(finalPath, "filesystem", "output target uses a Windows filesystem namespace alias");
  if (staging === "sibling") {
    const parentPath = path.dirname(targetPath);
    if (parentPath !== ".") {
      await targetRoot.mkdir(parentPath);
    }
    const siblingFinalPath = await targetRoot.resolve(targetPath);
    const result = await writeExternalFileViaSibling({
      finalPath: siblingFinalPath,
      write,
      producerIsolation,
      fallbackFileName,
      maxBytes,
      mode,
    });
    return { path: siblingFinalPath, result };
  }
  const staged = await tempFile({
    prefix: "fs-safe-output",
    fileName: tempFileNameForTarget(targetPath, fallbackFileName),
  });

  try {
    const result = await Function.prototype.call.call(write, options, staged.path);
    await targetRoot.copyIn(targetPath, staged.path, {
      maxBytes,
      mode,
      mkdir: true,
      sourceHardlinks: "reject",
    });
    return { path: finalPath, result };
  } finally {
    await staged.cleanup();
  }
}

function buildSiblingTempName(targetPath: string, fallbackFileName?: string): string {
  const prefix = `.fs-safe-output-${process.pid}-${randomUUID()}-`;
  const suffix = ".part";
  const safeTail = fitFileNameToPortableComponent({
    prefix,
    fileName: tempFileNameForTarget(targetPath, fallbackFileName),
    suffix,
  });
  return `${prefix}${safeTail}${suffix}`;
}

async function writeExternalFileViaSibling<T>(params: {
  finalPath: string;
  write: (filePath: string) => Promise<T>;
  producerIsolation?: "private-directory";
  fallbackFileName?: string;
  maxBytes?: number;
  mode?: number;
}): Promise<T> {
  assertNoWindowsPathAlias(params.finalPath, "filesystem", "output target uses a Windows filesystem namespace alias");
  const finalPath = path.resolve(params.finalPath);
  assertNoWindowsPathAlias(finalPath, "filesystem", "output target uses a Windows filesystem namespace alias");
  const { result } = await writeCallbackSibling({
    tempDir: path.dirname(finalPath),
    tempName: buildSiblingTempName(finalPath, params.fallbackFileName),
    write: params.write,
    producerIsolation: params.producerIsolation,
    resolveFinalPath: () => finalPath,
    mode: params.mode,
    maxBytes: params.maxBytes,
    syncTempFile: true,
    syncParentDir: true,
  });
  return result;
}
