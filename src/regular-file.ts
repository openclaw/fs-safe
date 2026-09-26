import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileDescriptorBoundedSync, readFileHandleBounded } from "./bounded-read.js";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { assertNoSymlinkParentsSync } from "./symlink-parents.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import {
  isNonRegularWriteOpenError,
  isNonRegularWriteOpenErrorSync,
  resolveNonblockingWriteFlag,
} from "./write-open-flags.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

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
  return statRegularFileSync(filePath);
}

export function statRegularFileSync(filePath: string): RegularFileStatResult {
  assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
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
  const { filePath, maxBytes, before } = prepareRegularRead(params);
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, resolveReadOpenFlags());
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${filePath}`);
    }
    throw err;
  }
  try {
    const stat = inspectOpenedRegularRead(handle.fd, filePath, before, maxBytes);
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
        translateBoundedReadOverflow(error, filePath, maxBytes);
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

function prepareRegularRead(params: {
  filePath: string;
  maxBytes?: number;
}): { filePath: string; maxBytes: number | undefined; before: BigIntStats } {
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  const filePath = params.filePath;
  assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
  assertNoUnsafeDeviceReadPath(filePath);
  let before: BigIntStats;
  try {
    before = inspectFileIdentitySync(() => {
      const stat = fsSync.lstatSync(filePath, { bigint: true });
      assertRegularReadStat(stat, filePath, true);
      return stat;
    });
  } catch (error) {
    throwReadPreviewError(error, filePath);
  }
  if (maxBytes !== undefined && before.size > maxBytes) {
    throw regularFileTooLargeError(filePath, maxBytes);
  }
  return { filePath, maxBytes, before };
}

function inspectOpenedRegularRead(
  fd: number,
  filePath: string,
  preOpenStat: BigIntStats,
  maxBytes: number | undefined,
): Stats {
  const stat = fsSync.fstatSync(fd);
  const identity = inspectFileIdentitySync(() => {
    const exact = fsSync.fstatSync(fd, { bigint: true });
    assertRegularReadStat(exact, filePath);
    return exact;
  }, preOpenStat);
  try {
    inspectFileIdentitySync(() => {
      const current = fsSync.lstatSync(filePath, { bigint: true });
      assertRegularReadStat(current, filePath);
      return current;
    }, identity);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${filePath}`);
    }
    throw error;
  }
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw regularFileTooLargeError(filePath, maxBytes);
  }
  return stat;
}

export function readRegularFileSync(params: { filePath: string; maxBytes?: number }): {
  buffer: Buffer;
  stat: Stats;
} {
  const { filePath, maxBytes, before } = prepareRegularRead(params);

  let fd: number;
  try {
    fd = fsSync.openSync(filePath, resolveReadOpenFlags());
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("path-mismatch", `File changed during read: ${filePath}`);
    }
    throw error;
  }
  try {
    const stat = inspectOpenedRegularRead(fd, filePath, before, maxBytes);
    // Keep capped reads incremental so raced growth cannot allocate unbounded content.
    let buffer: Buffer;
    try {
      buffer = maxBytes === undefined
        ? fsSync.readFileSync(fd)
        : readFileDescriptorBoundedSync(fd, maxBytes);
    } catch (error) {
      if (maxBytes !== undefined) {
        translateBoundedReadOverflow(error, filePath, maxBytes);
      }
      throw error;
    }
    return { buffer, stat };
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

function captureAppendOptions(options: AppendRegularFileOptions) {
  const filePath = options.filePath;
  assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
  return {
    filePath, content: options.content, encoding: options.encoding ?? "utf8",
    mode: options.mode ?? 0o600, maxFileBytes: options.maxFileBytes,
    rejectSymlinkParents: options.rejectSymlinkParents,
  };
}

function inspectAppendPath(filePath: string): BigIntStats {
  const stat = fsSync.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`Refusing to append through symlink: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Refusing to append to non-file: ${filePath}`);
  return stat;
}

function prepareRegularAppend(filePath: string, rejectSymlinkParents: boolean | undefined): BigIntStats | undefined {
  if (rejectSymlinkParents === true) {
    const unresolvedDir = path.dirname(filePath);
    assertNoSymlinkParentsSync({
      rootDir: path.parse(resolvePathPreservingWindowsRoot(unresolvedDir)).root,
      targetPath: unresolvedDir,
      allowMissing: false,
      allowRootChildSymlink: true,
      requireDirectories: true,
      messagePrefix: "Refusing to append under",
    });
  }

  try {
    return inspectFileIdentitySync(() => inspectAppendPath(filePath));
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
  }
}

function inspectOpenedRegularAppend(fd: number, filePath: string, preOpenStat: BigIntStats | undefined): BigIntStats {
  try {
    const identity = inspectFileIdentitySync(() => {
      const stat = fsSync.fstatSync(fd, { bigint: true });
      assertRegularAppendStat(stat, filePath);
      return stat;
    }, preOpenStat);
    inspectFileIdentitySync(() => {
      const current = fsSync.lstatSync(filePath, { bigint: true });
      assertRegularAppendStat(current, filePath);
      return current;
    }, identity);
    return identity;
  } catch (error) {
    throwAppendIdentityError(error, filePath);
  }
}

export async function appendRegularFile(options: AppendRegularFileOptions): Promise<void> {
  const { filePath, content, encoding, mode, maxFileBytes, rejectSymlinkParents } = captureAppendOptions(options);
  const preOpenStat = prepareRegularAppend(filePath, rejectSymlinkParents);

  const contentBytes = Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(content, encoding);
  if (
    maxFileBytes !== undefined &&
    Number(preOpenStat?.size ?? 0n) + contentBytes > maxFileBytes
  ) {
    return;
  }

  await getFsSafeTestHooks()?.beforeRegularFileAppendOpen?.(filePath);
  const flags = resolveRegularFileAppendFlags();
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, flags, mode);
  } catch (error) {
    if (await isNonRegularWriteOpenError(error, filePath, flags)) {
      throw new Error(`Refusing to append to non-file: ${filePath}`);
    }
    throw error;
  }
  try {
    const identity = inspectOpenedRegularAppend(handle.fd, filePath, preOpenStat);
    if (
      maxFileBytes !== undefined &&
      Number(identity.size) + contentBytes > maxFileBytes
    ) {
      return;
    }
    // Tighten before writing; restore explicit special bits only after content is complete.
    await handle.chmod(mode);
    await handle.appendFile(content, encoding);
    if (mode & 0o7000) await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

export function appendRegularFileSync(options: AppendRegularFileOptions): void {
  const { filePath, content, encoding, mode, maxFileBytes, rejectSymlinkParents } = captureAppendOptions(options);
  const preOpenStat = prepareRegularAppend(filePath, rejectSymlinkParents);

  const contentBuffer =
    typeof content === "string" ? Buffer.from(content, encoding) : Buffer.from(content);
  if (
    maxFileBytes !== undefined &&
    Number(preOpenStat?.size ?? 0n) + contentBuffer.byteLength > maxFileBytes
  ) {
    return;
  }

  getFsSafeTestHooks()?.beforeRegularFileAppendOpenSync?.(filePath);
  const flags = resolveRegularFileAppendFlags();
  let fd: number;
  try {
    fd = fsSync.openSync(filePath, flags, mode);
  } catch (error) {
    if (isNonRegularWriteOpenErrorSync(error, filePath, flags)) {
      throw new Error(`Refusing to append to non-file: ${filePath}`);
    }
    throw error;
  }
  try {
    const identity = inspectOpenedRegularAppend(fd, filePath, preOpenStat);
    if (
      maxFileBytes !== undefined &&
      Number(identity.size) + contentBuffer.byteLength > maxFileBytes
    ) {
      return;
    }
    fsSync.fchmodSync(fd, mode);
    fsSync.appendFileSync(fd, contentBuffer);
    if (mode & 0o7000) fsSync.fchmodSync(fd, mode);
  } finally {
    fsSync.closeSync(fd);
  }
}
