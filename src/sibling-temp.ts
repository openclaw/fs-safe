import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { applyDirectoryMode } from "./replace-file-descriptor.js";
import { root } from "./root.js";
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

function buildTempPath(dir: string, tempPrefix?: string): string {
  // Same FAT-family constraint as replace-file.ts: keep the sibling temp
  // basename within 8.3 (<=12 chars) so rename preserves file identity
  // on exFAT/FAT32 USB sticks. Honor a short caller prefix when it fits;
  // a hostile prefix (path separators) must still throw, not silently
  // collapse to a random name — callers rely on rejection for audit.
  const raw = tempPrefix ?? "";
  if (/[/\\]/.test(raw)) {
    throw new Error("sibling temp prefix must be a single path segment");
  }
  const requested = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = requested && requested.length <= 8 ? requested : randomUUID().slice(0, 8);
  return path.join(dir, `${stem}.tmp`);
}

export async function writeSiblingTempFile<T>(
  options: WriteSiblingTempFileOptions<T>,
): Promise<WriteSiblingTempFileResult<T>> {
  const dir = path.resolve(options.dir);
  await fs.mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  if (options.chmodDir !== false) {
    await applyDirectoryMode({
      fsModule: fs,
      dirPath: dir,
      mode: options.dirMode ?? 0o700,
      ignoreChmodError: true,
    });
  }
  return await writeCallbackSibling({
    tempPath: buildTempPath(dir, options.tempPrefix),
    write: options.writeTemp,
    resolveFinalPath: options.resolveFinalPath,
    mode: options.mode,
    ignoreModeError: true,
    syncTempFile: options.syncTempFile === true,
    syncParentDir: options.syncParentDir === true,
  });
}

function buildSiblingTempPath(_params: {
  targetPath: string;
  fallbackFileName: string;
  tempPrefix: string;
}): string {
  // NOTE: staging temp names stay within 8.3 (<=12 chars): FAT-family
  // filesystems (exFAT/FAT32 USB sticks) do not preserve file identity
  // across writes for longer basenames. The caller filename is honored
  // for the FINAL name via copyIn, never for the staging temp name.
  // A hostile tempPrefix (path separators) must still throw, not silently
  // collapse — callers rely on rejection for audit.
  if (/[/\\]/.test(_params.tempPrefix ?? "")) {
    throw new Error("sibling temp prefix must be a single path segment");
  }
  const sanitized = (_params.tempPrefix ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = sanitized && sanitized.length <= 8 ? sanitized : crypto.randomUUID().slice(0, 8);
  return path.join(path.dirname(_params.targetPath), `${stem}.tmp`);
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
