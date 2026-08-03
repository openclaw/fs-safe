import type { Stats } from "node:fs";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileDescriptorBoundedSync, readFileHandleBounded } from "./bounded-read.js";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { assertNoSymlinkParents, assertNoSymlinkParentsSync } from "./symlink-parents.js";

export type RegularFileStatResult = { missing: true } | { missing: false; stat: Stats };

type RegularFileAppendFlagConstants = Pick<
  typeof fsSync.constants,
  "O_APPEND" | "O_CREAT" | "O_WRONLY"
> &
  Partial<Pick<typeof fsSync.constants, "O_NOFOLLOW">>;

export type AppendRegularFileOptions = {
  filePath: string;
  content: string | Uint8Array;
  encoding?: BufferEncoding;
  maxFileBytes?: number;
  mode?: number;
  rejectSymlinkParents?: boolean;
};

export function resolveRegularFileAppendFlags(
  constants: RegularFileAppendFlagConstants = fsSync.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_APPEND |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

function resolveRegularFileReadFlags(): number {
  return (
    fsSync.constants.O_RDONLY |
    (typeof fsSync.constants.O_NOFOLLOW === "number" && process.platform !== "win32"
      ? fsSync.constants.O_NOFOLLOW
      : 0)
  );
}

function regularFileTooLargeError(filePath: string, maxBytes: number, cause?: unknown): FsSafeError {
  return new FsSafeError("too-large", `File exceeds ${maxBytes} bytes: ${filePath}`, { cause });
}

function translateBoundedReadOverflow(error: unknown, filePath: string, maxBytes: number): never {
  if (error instanceof FsSafeError && error.code === "too-large") {
    throw regularFileTooLargeError(filePath, maxBytes, error);
  }
  throw error;
}

export async function statRegularFile(filePath: string): Promise<RegularFileStatResult> {
  let stat: Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return { missing: true };
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("path must be a regular file");
  }
  return { missing: false, stat };
}

export function statRegularFileSync(filePath: string): RegularFileStatResult {
  let stat: Stats;
  try {
    stat = fsSync.lstatSync(filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return { missing: true };
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("path must be a regular file");
  }
  return { missing: false, stat };
}

export async function readRegularFile(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; stat: Stats }> {
  assertNoUnsafeDeviceReadPath(params.filePath);
  const result = await statRegularFile(params.filePath);
  if (result.missing) {
    throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
  }
  if (params.maxBytes !== undefined && result.stat.size > params.maxBytes) {
    throw regularFileTooLargeError(params.filePath, params.maxBytes);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(params.filePath, resolveRegularFileReadFlags());
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    let pathStat: Stats;
    try {
      pathStat = await fs.lstat(params.filePath);
    } catch (err) {
      if (isNotFoundPathError(err)) {
        throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
      }
      throw err;
    }
    verifyStableReadTarget({
      filePath: params.filePath,
      pathStat,
      postOpenStat: stat,
      preOpenStat: result.stat,
    });
    if (params.maxBytes !== undefined && stat.size > params.maxBytes) {
      throw regularFileTooLargeError(params.filePath, params.maxBytes);
    }
    // With a byte cap, avoid readFile(): a raced file growth would allocate
    // the oversized content before the post-read check could reject it.
    let buffer: Buffer;
    try {
      buffer =
        params.maxBytes === undefined
          ? await handle.readFile()
          : await readFileHandleBounded(handle, params.maxBytes);
    } catch (error) {
      if (params.maxBytes !== undefined) {
        translateBoundedReadOverflow(error, params.filePath, params.maxBytes);
      }
      throw error;
    }
    return { buffer, stat };
  } finally {
    await handle.close();
  }
}

function verifyStableReadTarget(params: {
  preOpenStat: Stats;
  postOpenStat: Stats;
  pathStat: Stats;
  filePath: string;
}): void {
  if (!params.postOpenStat.isFile() || params.pathStat.isSymbolicLink() || !params.pathStat.isFile()) {
    throw new Error(`File is not a regular file: ${params.filePath}`);
  }
  if (
    !sameFileIdentity(params.preOpenStat, params.postOpenStat) ||
    !sameFileIdentity(params.pathStat, params.postOpenStat)
  ) {
    throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
  }
}

function readOpenedRegularFileSync(params: {
  fd: number;
  filePath: string;
  preOpenStat: Stats;
  maxBytes?: number;
}): { buffer: Buffer; stat: Stats } {
  const stat = fsSync.fstatSync(params.fd);
  let pathStat: Stats;
  try {
    pathStat = fsSync.lstatSync(params.filePath);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
    }
    throw error;
  }
  verifyStableReadTarget({
    filePath: params.filePath,
    pathStat,
    postOpenStat: stat,
    preOpenStat: params.preOpenStat,
  });
  if (params.maxBytes !== undefined && stat.size > params.maxBytes) {
    throw regularFileTooLargeError(params.filePath, params.maxBytes);
  }
  // Keep capped sync reads incremental for the same reason as async reads:
  // readFileSync(fd) would buffer a raced oversized file before throwing.
  let buffer: Buffer;
  try {
    buffer =
      params.maxBytes === undefined
        ? fsSync.readFileSync(params.fd)
        : readFileDescriptorBoundedSync(params.fd, params.maxBytes);
  } catch (error) {
    if (params.maxBytes !== undefined) {
      translateBoundedReadOverflow(error, params.filePath, params.maxBytes);
    }
    throw error;
  }
  return { buffer, stat };
}

export function readRegularFileSync(params: { filePath: string; maxBytes?: number }): {
  buffer: Buffer;
  stat: Stats;
} {
  assertNoUnsafeDeviceReadPath(params.filePath);
  const result = statRegularFileSync(params.filePath);
  if (result.missing) {
    throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
  }
  if (params.maxBytes !== undefined && result.stat.size > params.maxBytes) {
    throw regularFileTooLargeError(params.filePath, params.maxBytes);
  }

  let fd: number;
  try {
    fd = fsSync.openSync(params.filePath, resolveRegularFileReadFlags());
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
    }
    throw error;
  }
  try {
    return readOpenedRegularFileSync({
      fd,
      filePath: params.filePath,
      preOpenStat: result.stat,
      maxBytes: params.maxBytes,
    });
  } finally {
    fsSync.closeSync(fd);
  }
}

function verifyStableAppendTarget(params: {
  preOpenStat?: Stats;
  postOpenStat: Stats;
  filePath: string;
}): void {
  if (!params.postOpenStat.isFile()) {
    throw new Error(`Refusing to append to non-file: ${params.filePath}`);
  }
  if (params.postOpenStat.nlink > 1) {
    throw new Error(`Refusing to append to hardlinked file: ${params.filePath}`);
  }
  const pre = params.preOpenStat;
  if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) {
    throw new Error(`Refusing to append after file changed: ${params.filePath}`);
  }
}

export async function appendRegularFile(options: AppendRegularFileOptions): Promise<void> {
  if (options.rejectSymlinkParents === true) {
    const resolvedDir = path.resolve(path.dirname(options.filePath));
    await assertNoSymlinkParents({
      rootDir: path.parse(resolvedDir).root,
      targetPath: resolvedDir,
      allowMissing: false,
      allowRootChildSymlink: true,
      requireDirectories: true,
      messagePrefix: "Refusing to append under",
    });
  }

  let preOpenStat: Stats | undefined;
  try {
    const stat = await fs.lstat(options.filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to append through symlink: ${options.filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to append to non-file: ${options.filePath}`);
    }
    preOpenStat = stat;
  } catch (err) {
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  const contentBytes = Buffer.isBuffer(options.content)
    ? options.content.byteLength
    : Buffer.byteLength(options.content, options.encoding ?? "utf8");
  if (
    options.maxFileBytes !== undefined &&
    (preOpenStat?.size ?? 0) + contentBytes > options.maxFileBytes
  ) {
    return;
  }

  const handle = await fs.open(
    options.filePath,
    resolveRegularFileAppendFlags(),
    options.mode ?? 0o600,
  );
  try {
    const stat = await handle.stat();
    verifyStableAppendTarget({ preOpenStat, postOpenStat: stat, filePath: options.filePath });
    if (options.maxFileBytes !== undefined && stat.size + contentBytes > options.maxFileBytes) {
      return;
    }
    await handle.chmod(options.mode ?? 0o600);
    await handle.appendFile(options.content, options.encoding ?? "utf8");
  } finally {
    await handle.close();
  }
}

export function appendRegularFileSync(options: AppendRegularFileOptions): void {
  if (options.rejectSymlinkParents === true) {
    const resolvedDir = path.resolve(path.dirname(options.filePath));
    assertNoSymlinkParentsSync({
      rootDir: path.parse(resolvedDir).root,
      targetPath: resolvedDir,
      allowMissing: false,
      allowRootChildSymlink: true,
      requireDirectories: true,
      messagePrefix: "Refusing to append under",
    });
  }

  let preOpenStat: Stats | undefined;
  try {
    const stat = fsSync.lstatSync(options.filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to append through symlink: ${options.filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to append to non-file: ${options.filePath}`);
    }
    preOpenStat = stat;
  } catch (err) {
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  const contentBuffer =
    typeof options.content === "string"
      ? Buffer.from(options.content, options.encoding ?? "utf8")
      : Buffer.from(options.content);
  if (
    options.maxFileBytes !== undefined &&
    (preOpenStat?.size ?? 0) + contentBuffer.byteLength > options.maxFileBytes
  ) {
    return;
  }

  const fd = fsSync.openSync(
    options.filePath,
    resolveRegularFileAppendFlags(),
    options.mode ?? 0o600,
  );
  try {
    const stat = fsSync.fstatSync(fd);
    verifyStableAppendTarget({ preOpenStat, postOpenStat: stat, filePath: options.filePath });
    if (
      options.maxFileBytes !== undefined &&
      stat.size + contentBuffer.byteLength > options.maxFileBytes
    ) {
      return;
    }
    fsSync.fchmodSync(fd, options.mode ?? 0o600);
    fsSync.writeSync(fd, contentBuffer, 0, contentBuffer.byteLength);
  } finally {
    fsSync.closeSync(fd);
  }
}
