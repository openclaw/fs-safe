import syncFs, { type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";

export type ReplaceFileDestinationHardlinkPolicy = "reject";
export type ReplaceFileCopyFallbackRestorePolicy = "restore-original" | "none";
export type ReplaceFileAtomicRestoreCleanup = "restored" | "restore-failed";
export type ReplaceFileAtomicRestoreFailureDetails = {
  cleanup: ReplaceFileAtomicRestoreCleanup;
};

type AsyncFallbackFs = {
  lstat: typeof import("node:fs/promises").lstat;
  open: typeof import("node:fs/promises").open;
  rm: typeof import("node:fs/promises").rm;
  unlink: typeof import("node:fs/promises").unlink;
};

type SyncFallbackFs = Pick<
  typeof syncFs,
  | "closeSync"
  | "fstatSync"
  | "fsyncSync"
  | "ftruncateSync"
  | "lstatSync"
  | "openSync"
  | "readSync"
  | "rmSync"
  | "unlinkSync"
  | "writeSync"
>;

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in syncFs.constants;
const NOFOLLOW = SUPPORTS_NOFOLLOW ? syncFs.constants.O_NOFOLLOW : 0;
const OPEN_READ_FLAGS = syncFs.constants.O_RDONLY | NOFOLLOW;
const OPEN_READ_WRITE_FLAGS = syncFs.constants.O_RDWR | NOFOLLOW;
const OPEN_WRITE_EXCLUSIVE_FLAGS =
  syncFs.constants.O_WRONLY | syncFs.constants.O_CREAT | syncFs.constants.O_EXCL | NOFOLLOW;
const READ_CHUNK_BYTES = 64 * 1024;

function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertPinnedDestination(
  pathname: Stats,
  opened: Stats,
  dest: string,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy,
): void {
  if (pathname.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  }
  if (!pathname.isFile() || !opened.isFile()) {
    throw new FsSafeError("not-file", `Copy fallback destination must be a regular file: ${dest}`);
  }
  if (!sameFileIdentity(pathname, opened)) {
    throw new FsSafeError("path-mismatch", `Copy fallback destination changed while opening: ${dest}`);
  }
  if (hardlinks === "reject" && opened.nlink > 1) {
    throw new FsSafeError("hardlink", `Hardlinked copy fallback destination not allowed: ${dest}`);
  }
}

async function openPinnedDestination(
  fsModule: AsyncFallbackFs,
  dest: string,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy,
): Promise<{ handle: FileHandle; stat: Stats } | null> {
  const preview = await fsModule.lstat(dest).catch((error) => {
    if (notFound(error)) return null;
    throw error;
  });
  if (!preview) return null;
  if (preview.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  }

  const handle = await fsModule.open(dest, OPEN_READ_WRITE_FLAGS);
  try {
    const opened = await handle.stat();
    const current = await fsModule.lstat(dest);
    assertPinnedDestination(current, opened, dest, hardlinks);
    return { handle, stat: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openPinnedDestinationSync(
  fsModule: SyncFallbackFs,
  dest: string,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy,
): { fd: number; stat: Stats } | null {
  let preview: Stats;
  try {
    preview = fsModule.lstatSync(dest);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  if (preview.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  }

  const fd = fsModule.openSync(dest, OPEN_READ_WRITE_FLAGS);
  try {
    const opened = fsModule.fstatSync(fd);
    assertPinnedDestination(fsModule.lstatSync(dest), opened, dest, hardlinks);
    return { fd, stat: opened };
  } catch (error) {
    fsModule.closeSync(fd);
    throw error;
  }
}

export async function assertDestinationHardlinkPolicy(
  fsModule: AsyncFallbackFs,
  dest: string,
  policy?: ReplaceFileDestinationHardlinkPolicy,
): Promise<void> {
  if (policy !== "reject") return;
  const preview = await fsModule.lstat(dest).catch((error) => {
    if (notFound(error)) return null;
    throw error;
  });
  if (!preview || preview.isSymbolicLink() || !preview.isFile()) return;

  const handle = await fsModule.open(dest, OPEN_READ_FLAGS);
  try {
    const opened = await handle.stat();
    const current = await fsModule.lstat(dest);
    if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(current, opened)) {
      throw new FsSafeError("path-mismatch", `Atomic replace destination changed while opening: ${dest}`);
    }
    if (opened.nlink > 1) {
      throw new FsSafeError("hardlink", `Hardlinked atomic replace destination not allowed: ${dest}`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function assertDestinationHardlinkPolicySync(
  fsModule: SyncFallbackFs,
  dest: string,
  policy?: ReplaceFileDestinationHardlinkPolicy,
): void {
  if (policy !== "reject") return;
  let preview: Stats;
  try {
    preview = fsModule.lstatSync(dest);
  } catch (error) {
    if (notFound(error)) return;
    throw error;
  }
  if (preview.isSymbolicLink() || !preview.isFile()) return;

  const fd = fsModule.openSync(dest, OPEN_READ_FLAGS);
  try {
    const opened = fsModule.fstatSync(fd);
    const current = fsModule.lstatSync(dest);
    if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(current, opened)) {
      throw new FsSafeError("path-mismatch", `Atomic replace destination changed while opening: ${dest}`);
    }
    if (opened.nlink > 1) {
      throw new FsSafeError("hardlink", `Hardlinked atomic replace destination not allowed: ${dest}`);
    }
  } finally {
    fsModule.closeSync(fd);
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - position + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maxBytes) {
      throw new FsSafeError("too-large", `Atomic replace restore snapshot exceeds maxRestoreBytes (${maxBytes})`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

function readBoundedSync(fsModule: SyncFallbackFs, fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - position + 1));
    const bytesRead = fsModule.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maxBytes) {
      throw new FsSafeError("too-large", `Atomic replace restore snapshot exceeds maxRestoreBytes (${maxBytes})`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  await handle.truncate(0);
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, written);
    if (result.bytesWritten === 0) throw new Error("Copy fallback write made no progress");
    written += result.bytesWritten;
  }
  await handle.truncate(data.length);
}

function writeAllSync(fsModule: SyncFallbackFs, fd: number, data: Buffer): void {
  fsModule.ftruncateSync(fd, 0);
  let written = 0;
  while (written < data.length) {
    const bytesWritten = fsModule.writeSync(fd, data, written, data.length - written, written);
    if (bytesWritten === 0) throw new Error("Copy fallback write made no progress");
    written += bytesWritten;
  }
  fsModule.ftruncateSync(fd, data.length);
}

function restoreFailure(
  writeError: unknown,
  cleanup: ReplaceFileAtomicRestoreCleanup,
  restoreError?: unknown,
): FsSafeError {
  const primary = writeError instanceof Error ? writeError : new Error(String(writeError));
  const details: ReplaceFileAtomicRestoreFailureDetails = { cleanup };
  const cause = restoreError
    ? new AggregateError([primary, restoreError], "copy fallback and original restoration both failed")
    : primary;
  return new FsSafeError(
    "helper-failed",
    cleanup === "restored"
      ? `Atomic copy fallback failed; original destination restored: ${primary.message}`
      : `Atomic copy fallback failed and original restoration failed: ${primary.message}`,
    { cause, details },
  );
}

async function replacePinnedWithRestore(
  handle: FileHandle,
  replacement: Buffer,
  maxRestoreBytes: number,
): Promise<void> {
  const original = await readBounded(handle, maxRestoreBytes);
  try {
    await writeAll(handle, replacement);
    await handle.sync();
  } catch (writeError) {
    try {
      await writeAll(handle, original);
      await handle.sync();
      throw restoreFailure(writeError, "restored");
    } catch (restoreError) {
      if (restoreError instanceof FsSafeError && restoreError.details?.cleanup === "restored") {
        throw restoreError;
      }
      throw restoreFailure(writeError, "restore-failed", restoreError);
    }
  }
}

function replacePinnedWithRestoreSync(
  fsModule: SyncFallbackFs,
  fd: number,
  replacement: Buffer,
  maxRestoreBytes: number,
): void {
  const original = readBoundedSync(fsModule, fd, maxRestoreBytes);
  try {
    writeAllSync(fsModule, fd, replacement);
    fsModule.fsyncSync(fd);
  } catch (writeError) {
    try {
      writeAllSync(fsModule, fd, original);
      fsModule.fsyncSync(fd);
      throw restoreFailure(writeError, "restored");
    } catch (restoreError) {
      if (restoreError instanceof FsSafeError && restoreError.details?.cleanup === "restored") {
        throw restoreError;
      }
      throw restoreFailure(writeError, "restore-failed", restoreError);
    }
  }
}

export async function copyFallbackReplace(params: {
  fsModule: AsyncFallbackFs;
  src: string;
  dest: string;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  restore: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
}): Promise<void> {
  const sourcePreview = await params.fsModule.lstat(params.src);
  if (sourcePreview.isSymbolicLink() || !sourcePreview.isFile()) {
    throw new Error(`Refusing copy fallback from non-file source: ${params.src}`);
  }
  const sourceHandle = await params.fsModule.open(params.src, OPEN_READ_FLAGS);
  let destHandle: FileHandle | null = null;
  try {
    const sourceStat = await sourceHandle.stat();
    const sourceCurrent = await params.fsModule.lstat(params.src);
    if (!sourceStat.isFile() || sourceCurrent.isSymbolicLink() || !sameFileIdentity(sourceStat, sourceCurrent)) {
      throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${params.src}`);
    }
    const replacement = await sourceHandle.readFile();

    if (params.restore === "restore-original") {
      const pinned = await openPinnedDestination(
        params.fsModule,
        params.dest,
        params.destinationHardlinks,
      );
      if (pinned) {
        destHandle = pinned.handle;
        await replacePinnedWithRestore(destHandle, replacement, params.maxRestoreBytes!);
      }
    }

    if (!destHandle) {
      const destStat = await params.fsModule.lstat(params.dest).catch((error) => {
        if (notFound(error)) return null;
        throw error;
      });
      if (destStat?.isSymbolicLink()) {
        throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${params.dest}`);
      }
      if (destStat) {
        await assertDestinationHardlinkPolicy(
          params.fsModule,
          params.dest,
          params.destinationHardlinks,
        );
        await params.fsModule.rm(params.dest, { force: true });
      }
      destHandle = await params.fsModule.open(
        params.dest,
        OPEN_WRITE_EXCLUSIVE_FLAGS,
        sourceStat.mode & 0o777,
      );
      await destHandle.writeFile(replacement);
    }
    await destHandle.chmod(sourceStat.mode);
  } finally {
    await destHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
  await params.fsModule.unlink(params.src).catch(() => undefined);
}

export function copyFallbackReplaceSync(params: {
  fsModule: SyncFallbackFs;
  src: string;
  dest: string;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  restore: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  fchmodSync?: (fd: number, mode: number) => void;
}): void {
  const sourcePreview = params.fsModule.lstatSync(params.src);
  if (sourcePreview.isSymbolicLink() || !sourcePreview.isFile()) {
    throw new Error(`Refusing copy fallback from non-file source: ${params.src}`);
  }
  const sourceFd = params.fsModule.openSync(params.src, OPEN_READ_FLAGS);
  let destFd: number | undefined;
  try {
    const sourceStat = params.fsModule.fstatSync(sourceFd);
    const sourceCurrent = params.fsModule.lstatSync(params.src);
    if (!sourceStat.isFile() || sourceCurrent.isSymbolicLink() || !sameFileIdentity(sourceStat, sourceCurrent)) {
      throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${params.src}`);
    }
    const replacement = readBoundedSync(params.fsModule, sourceFd, Number.MAX_SAFE_INTEGER);

    if (params.restore === "restore-original") {
      const pinned = openPinnedDestinationSync(
        params.fsModule,
        params.dest,
        params.destinationHardlinks,
      );
      if (pinned) {
        destFd = pinned.fd;
        replacePinnedWithRestoreSync(
          params.fsModule,
          destFd,
          replacement,
          params.maxRestoreBytes!,
        );
      }
    }

    if (destFd === undefined) {
      let destStat: Stats | null = null;
      try {
        destStat = params.fsModule.lstatSync(params.dest);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      if (destStat?.isSymbolicLink()) {
        throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${params.dest}`);
      }
      if (destStat) {
        assertDestinationHardlinkPolicySync(
          params.fsModule,
          params.dest,
          params.destinationHardlinks,
        );
        params.fsModule.rmSync(params.dest, { force: true });
      }
      destFd = params.fsModule.openSync(
        params.dest,
        OPEN_WRITE_EXCLUSIVE_FLAGS,
        sourceStat.mode & 0o777,
      );
      writeAllSync(params.fsModule, destFd, replacement);
    }
    params.fchmodSync?.(destFd, sourceStat.mode);
  } finally {
    if (destFd !== undefined) {
      try {
        params.fsModule.closeSync(destFd);
      } catch {
        // Best-effort close after fallback replacement.
      }
    }
    try {
      params.fsModule.closeSync(sourceFd);
    } catch {
      // Best-effort close after fallback replacement.
    }
  }
  try {
    params.fsModule.unlinkSync(params.src);
  } catch {
    // Best-effort cleanup after fallback replacement.
  }
}
