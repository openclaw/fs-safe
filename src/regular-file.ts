import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileDescriptorBoundedSync, readFileHandleBounded } from "./bounded-read.js";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { assertNoSymlinkParents, assertNoSymlinkParentsSync } from "./symlink-parents.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import {
  isNonRegularWriteOpenError,
  isNonRegularWriteOpenErrorSync,
  resolveNonblockingWriteFlag,
} from "./write-open-flags.js";

export type RegularFileStatResult = { missing: true } | { missing: false; stat: Stats };

type RegularFileAppendFlagConstants = Pick<
  typeof fsSync.constants,
  "O_APPEND" | "O_CREAT" | "O_WRONLY"
> &
  Partial<Pick<typeof fsSync.constants, "O_NOFOLLOW" | "O_NONBLOCK">>;

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
    (typeof noFollow === "number" ? noFollow : 0) |
    resolveNonblockingWriteFlag(constants)
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
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  assertNoUnsafeDeviceReadPath(params.filePath);
  const before = await inspectFileIdentity(async () => {
    const stat = await fs.lstat(params.filePath, { bigint: true });
    assertRegularReadStat(stat, params.filePath, true);
    return stat;
  }).catch((error) => throwReadPreviewError(error, params.filePath));
  if (maxBytes !== undefined && before.size > maxBytes) {
    throw regularFileTooLargeError(params.filePath, maxBytes);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(params.filePath, resolveReadOpenFlags());
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    const identity = await inspectFileIdentity(async () => {
      const exact = await handle.stat({ bigint: true });
      assertRegularReadStat(exact, params.filePath);
      return exact;
    }, before);
    try {
      await inspectFileIdentity(async () => {
        const current = await fs.lstat(params.filePath, { bigint: true });
        assertRegularReadStat(current, params.filePath);
        return current;
      }, identity);
    } catch (err) {
      if (isNotFoundPathError(err)) {
        throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
      }
      throw err;
    }
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw regularFileTooLargeError(params.filePath, maxBytes);
    }
    // With a byte cap, avoid readFile(): a raced file growth would allocate
    // the oversized content before the post-read check could reject it.
    let buffer: Buffer;
    try {
      buffer =
        maxBytes === undefined
          ? await handle.readFile()
          : await readFileHandleBounded(handle, maxBytes);
    } catch (error) {
      if (maxBytes !== undefined) {
        translateBoundedReadOverflow(error, params.filePath, maxBytes);
      }
      throw error;
    }
    return { buffer, stat };
  } finally {
    await handle.close();
  }
}

function throwReadPreviewError(error: unknown, filePath: string): never {
  if (isNotFoundPathError(error)) {
    throw Object.assign(new Error(`File not found: ${filePath}`), { code: "ENOENT" });
  }
  throw error;
}

function assertRegularReadStat(stat: BigIntStats, filePath: string, preview = false): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(preview ? "path must be a regular file" : `File is not a regular file: ${filePath}`);
  }
}

function readOpenedRegularFileSync(params: {
  fd: number;
  filePath: string;
  preOpenStat: BigIntStats;
  maxBytes?: number;
}): { buffer: Buffer; stat: Stats } {
  const stat = fsSync.fstatSync(params.fd);
  const identity = inspectFileIdentitySync(() => {
    const exact = fsSync.fstatSync(params.fd, { bigint: true });
    assertRegularReadStat(exact, params.filePath);
    return exact;
  }, params.preOpenStat);
  try {
    inspectFileIdentitySync(() => {
      const current = fsSync.lstatSync(params.filePath, { bigint: true });
      assertRegularReadStat(current, params.filePath);
      return current;
    }, identity);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${params.filePath}`);
    }
    throw error;
  }
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
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  assertNoUnsafeDeviceReadPath(params.filePath);
  let before: BigIntStats;
  try {
    before = inspectFileIdentitySync(() => {
      const stat = fsSync.lstatSync(params.filePath, { bigint: true });
      assertRegularReadStat(stat, params.filePath, true);
      return stat;
    });
  } catch (error) {
    throwReadPreviewError(error, params.filePath);
  }
  if (maxBytes !== undefined && before.size > maxBytes) {
    throw regularFileTooLargeError(params.filePath, maxBytes);
  }

  let fd: number;
  try {
    fd = fsSync.openSync(params.filePath, resolveReadOpenFlags());
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
      preOpenStat: before,
      maxBytes,
    });
  } finally {
    fsSync.closeSync(fd);
  }
}

function assertRegularAppendStat(stat: BigIntStats, filePath: string): void {
  if (!stat.isFile()) {
    throw new Error(`Refusing to append to non-file: ${filePath}`);
  }
  if (stat.nlink > 1n) {
    throw new Error(`Refusing to append to hardlinked file: ${filePath}`);
  }
}

function throwAppendIdentityError(error: unknown, filePath: string): never {
  if (isNotFoundPathError(error) ||
    (error instanceof FsSafeError && error.code === "path-mismatch")) {
    throw new Error(`Refusing to append after file changed: ${filePath}`, { cause: error });
  }
  throw error;
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

  let preOpenStat: BigIntStats | undefined;
  try {
    preOpenStat = await inspectFileIdentity(async () => {
      const stat = await fs.lstat(options.filePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to append through symlink: ${options.filePath}`);
      }
      if (!stat.isFile()) {
        throw new Error(`Refusing to append to non-file: ${options.filePath}`);
      }
      return stat;
    });
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
  }

  const contentBytes = Buffer.isBuffer(options.content)
    ? options.content.byteLength
    : Buffer.byteLength(options.content, options.encoding ?? "utf8");
  if (
    options.maxFileBytes !== undefined &&
    Number(preOpenStat?.size ?? 0n) + contentBytes > options.maxFileBytes
  ) {
    return;
  }

  await getFsSafeTestHooks()?.beforeRegularFileAppendOpen?.(options.filePath);
  const flags = resolveRegularFileAppendFlags();
  let handle: FileHandle;
  try {
    handle = await fs.open(options.filePath, flags, options.mode ?? 0o600);
  } catch (error) {
    if (await isNonRegularWriteOpenError(error, options.filePath, flags)) {
      throw new Error(`Refusing to append to non-file: ${options.filePath}`);
    }
    throw error;
  }
  try {
    let identity: BigIntStats;
    try {
      identity = await inspectFileIdentity(async () => {
        const stat = await handle.stat({ bigint: true });
        assertRegularAppendStat(stat, options.filePath);
        return stat;
      }, preOpenStat);
      await inspectFileIdentity(async () => {
        const current = await fs.lstat(options.filePath, { bigint: true });
        assertRegularAppendStat(current, options.filePath);
        return current;
      }, identity);
    } catch (error) {
      throwAppendIdentityError(error, options.filePath);
    }
    if (
      options.maxFileBytes !== undefined &&
      Number(identity.size) + contentBytes > options.maxFileBytes
    ) {
      return;
    }
    const mode = options.mode ?? 0o600;
    // Tighten before writing; restore explicit special bits only after content is complete.
    await handle.chmod(mode);
    await handle.appendFile(options.content, options.encoding ?? "utf8");
    if (mode & 0o7000) await handle.chmod(mode);
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

  let preOpenStat: BigIntStats | undefined;
  try {
    preOpenStat = inspectFileIdentitySync(() => {
      const stat = fsSync.lstatSync(options.filePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to append through symlink: ${options.filePath}`);
      }
      if (!stat.isFile()) {
        throw new Error(`Refusing to append to non-file: ${options.filePath}`);
      }
      return stat;
    });
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
  }

  const contentBuffer =
    typeof options.content === "string"
      ? Buffer.from(options.content, options.encoding ?? "utf8")
      : Buffer.from(options.content);
  if (
    options.maxFileBytes !== undefined &&
    Number(preOpenStat?.size ?? 0n) + contentBuffer.byteLength > options.maxFileBytes
  ) {
    return;
  }

  getFsSafeTestHooks()?.beforeRegularFileAppendOpenSync?.(options.filePath);
  const flags = resolveRegularFileAppendFlags();
  let fd: number;
  try {
    fd = fsSync.openSync(options.filePath, flags, options.mode ?? 0o600);
  } catch (error) {
    if (isNonRegularWriteOpenErrorSync(error, options.filePath, flags)) {
      throw new Error(`Refusing to append to non-file: ${options.filePath}`);
    }
    throw error;
  }
  try {
    let identity: BigIntStats;
    try {
      identity = inspectFileIdentitySync(() => {
        const stat = fsSync.fstatSync(fd, { bigint: true });
        assertRegularAppendStat(stat, options.filePath);
        return stat;
      }, preOpenStat);
      inspectFileIdentitySync(() => {
        const current = fsSync.lstatSync(options.filePath, { bigint: true });
        assertRegularAppendStat(current, options.filePath);
        return current;
      }, identity);
    } catch (error) {
      throwAppendIdentityError(error, options.filePath);
    }
    if (
      options.maxFileBytes !== undefined &&
      Number(identity.size) + contentBuffer.byteLength > options.maxFileBytes
    ) {
      return;
    }
    const mode = options.mode ?? 0o600;
    fsSync.fchmodSync(fd, mode);
    fsSync.appendFileSync(fd, contentBuffer);
    if (mode & 0o7000) fsSync.fchmodSync(fd, mode);
  } finally {
    fsSync.closeSync(fd);
  }
}
