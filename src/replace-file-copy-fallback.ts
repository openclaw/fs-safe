import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { readBoundedAsync, readBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { readOwnedCopySource, readOwnedCopySourceSync } from "./replace-file-copy-source.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";

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

type DestinationAdmission = "restore" | "hardlinks";

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in syncFs.constants;
const NOFOLLOW = SUPPORTS_NOFOLLOW ? syncFs.constants.O_NOFOLLOW : 0;
const OPEN_READ_FLAGS = resolveReadOpenFlags();
const OPEN_READ_WRITE_FLAGS = syncFs.constants.O_RDWR | NOFOLLOW;
const OPEN_WRITE_EXCLUSIVE_FLAGS =
  syncFs.constants.O_WRONLY | syncFs.constants.O_CREAT | syncFs.constants.O_EXCL | NOFOLLOW;

function closeSyncAfterAdmissionFailure(
  fsModule: Pick<SyncFallbackFs, "closeSync">,
  fd: number,
  error: unknown,
): never {
  try {
    fsModule.closeSync(fd);
  } catch {
    // Preserve the already-selected admission failure.
  }
  throw error;
}

function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function admitDestinationKind(
  pathname: BigIntStats,
  opened: BigIntStats,
  dest: string,
  admission: DestinationAdmission,
): BigIntStats {
  if (admission === "hardlinks") {
    if (pathname.isSymbolicLink() || !pathname.isFile()) {
      throw new FsSafeError("path-mismatch", `Atomic replace destination changed while opening: ${dest}`);
    }
  } else if (pathname.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  } else if (!pathname.isFile() || !opened.isFile()) {
    throw new FsSafeError("not-file", `Copy fallback destination must be a regular file: ${dest}`);
  }
  return pathname;
}

function assertDestinationLinks(opened: BigIntStats, dest: string, admission: DestinationAdmission,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy): void {
  if ((admission === "hardlinks" || hardlinks === "reject") && opened.nlink > 1n) {
    throw new FsSafeError("hardlink", `Hardlinked ${admission === "hardlinks" ? "atomic replace" : "copy fallback"} destination not allowed: ${dest}`);
  }
}

function inspectPinnedDestinationSync(fsModule: SyncFallbackFs, fd: number, dest: string,
  admission: DestinationAdmission, hardlinks?: ReplaceFileDestinationHardlinkPolicy): void {
  const opened = inspectFileIdentitySync(() => fsModule.fstatSync(fd, { bigint: true }));
  inspectFileIdentitySync(() => admitDestinationKind(fsModule.lstatSync(dest, { bigint: true }), opened, dest, admission), opened);
  assertDestinationLinks(opened, dest, admission, hardlinks);
}

async function openPinnedDestination(
  fsModule: AsyncFallbackFs,
  dest: string,
  admission: DestinationAdmission,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy,
): Promise<FileHandle | null> {
  let preview: Stats | null;
  try {
    preview = fsModule === fs ? syncFs.lstatSync(dest) : await fsModule.lstat(dest);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  if (!preview) return null;
  if (admission === "hardlinks" && (preview.isSymbolicLink() || !preview.isFile())) return null;
  if (admission === "restore" && preview.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  }

  const handle = await fsModule.open(dest, admission === "restore" ? OPEN_READ_WRITE_FLAGS : OPEN_READ_FLAGS);
  try {
    if (fsModule === fs) inspectPinnedDestinationSync(syncFs, handle.fd, dest, admission, hardlinks);
    else {
      const opened = await inspectFileIdentity(() => handle.stat({ bigint: true }));
      await inspectFileIdentity(async () => admitDestinationKind(await fsModule.lstat(dest, { bigint: true }), opened, dest, admission), opened);
      assertDestinationLinks(opened, dest, admission, hardlinks);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openPinnedDestinationSync(
  fsModule: SyncFallbackFs,
  dest: string,
  admission: DestinationAdmission,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy,
): number | null {
  let preview: Stats;
  try {
    preview = fsModule.lstatSync(dest);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  if (admission === "hardlinks" && (preview.isSymbolicLink() || !preview.isFile())) return null;
  if (admission === "restore" && preview.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  }

  const fd = fsModule.openSync(dest, admission === "restore" ? OPEN_READ_WRITE_FLAGS : OPEN_READ_FLAGS);
  try {
    inspectPinnedDestinationSync(fsModule, fd, dest, admission, hardlinks);
    return fd;
  } catch (error) {
    closeSyncAfterAdmissionFailure(fsModule, fd, error);
  }
}

export async function assertDestinationHardlinkPolicy(
  fsModule: AsyncFallbackFs,
  dest: string,
  policy?: ReplaceFileDestinationHardlinkPolicy,
): Promise<void> {
  if (policy !== "reject") return;
  const handle = await openPinnedDestination(fsModule, dest, "hardlinks");
  if (handle) await handle.close().catch(() => undefined);
}

export function assertDestinationHardlinkPolicySync(
  fsModule: SyncFallbackFs,
  dest: string,
  policy?: ReplaceFileDestinationHardlinkPolicy,
): void {
  if (policy !== "reject") return;
  const fd = openPinnedDestinationSync(fsModule, dest, "hardlinks");
  if (fd !== null) fsModule.closeSync(fd);
}

function restoreReadOptions(stat: Stats, maxBytes: number) {
  return {
    initialSize: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : undefined,
    createLimitError: () => new FsSafeError("too-large", `Atomic replace restore snapshot exceeds maxRestoreBytes (${maxBytes})`),
  };
}

async function readRestoreSnapshot(handle: FileHandle, maxBytes: number, stat: Stats): Promise<Buffer> {
  let position = 0;
  return await readBoundedAsync(maxBytes, async (buffer, length) => {
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    position += bytesRead;
    return bytesRead;
  }, restoreReadOptions(stat, maxBytes));
}

function readRestoreSnapshotSync(fsModule: SyncFallbackFs, fd: number, maxBytes: number, stat: Stats): Buffer {
  let position = 0;
  return readBoundedSync(maxBytes, (buffer, length) => {
    const bytesRead = fsModule.readSync(fd, buffer, 0, length, position);
    position += bytesRead;
    return bytesRead;
  }, restoreReadOptions(stat, maxBytes));
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
  const cause = cleanup === "restore-failed"
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
  fsModule: AsyncFallbackFs,
  handle: FileHandle,
  replacement: Buffer,
  maxRestoreBytes: number,
  replacementMode: number,
): Promise<void> {
  const originalStat = fsModule === fs ? syncFs.fstatSync(handle.fd) : await handle.stat();
  const originalMode = originalStat.mode;
  const original = await readRestoreSnapshot(handle, maxRestoreBytes, originalStat);
  try {
    await writeAll(handle, replacement);
    await handle.chmod(replacementMode);
    await handle.sync();
  } catch (writeError) {
    try {
      await writeAll(handle, original);
      await handle.chmod(originalMode);
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
  replacementMode: number,
  fchmodSync?: (fd: number, mode: number) => void,
): void {
  const originalStat = fsModule.fstatSync(fd);
  const originalMode = originalStat.mode;
  const original = readRestoreSnapshotSync(fsModule, fd, maxRestoreBytes, originalStat);
  try {
    writeAllSync(fsModule, fd, replacement);
    fchmodSync?.(fd, replacementMode);
    fsModule.fsyncSync(fd);
  } catch (writeError) {
    try {
      writeAllSync(fsModule, fd, original);
      fchmodSync?.(fd, originalMode);
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
  expectedSourceIdentity?: BigIntStats;
  sync: boolean;
}): Promise<void> {
  const source = await readOwnedCopySource({
    fsModule: params.fsModule,
    src: params.src,
    expectedIdentity: params.expectedSourceIdentity,
  });
  const { replacement } = source;
  let destHandle: FileHandle | null = null;
  let closeRequiredForSuccess = false;
  try {
    if (params.restore === "restore-original") {
      const pinned = await openPinnedDestination(
        params.fsModule,
        params.dest,
        "restore",
        params.destinationHardlinks,
      );
      if (pinned) {
        destHandle = pinned;
        await replacePinnedWithRestore(
          params.fsModule,
          destHandle,
          replacement,
          params.maxRestoreBytes!,
          source.mode,
        );
      }
    }

    if (!destHandle) {
      let destStat: Stats | null = null;
      try {
        destStat = params.fsModule === fs
          ? syncFs.lstatSync(params.dest) : await params.fsModule.lstat(params.dest);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
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
        source.mode & 0o777,
      );
      await destHandle.writeFile(replacement);
      await destHandle.chmod(source.mode);
      if (params.sync) {
        await destHandle.sync();
      }
      closeRequiredForSuccess = !params.sync;
    }
  } finally {
    if (destHandle) {
      try {
        await destHandle.close();
      } catch (closeError) {
        if (closeRequiredForSuccess) {
          throw closeError;
        }
      }
    }
  }
}

export function copyFallbackReplaceSync(params: {
  fsModule: SyncFallbackFs;
  src: string;
  dest: string;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  restore: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  expectedSourceIdentity?: BigIntStats;
  fchmodSync?: (fd: number, mode: number) => void;
  sync: boolean;
}): void {
  const source = readOwnedCopySourceSync({
    fsModule: params.fsModule,
    src: params.src,
    expectedIdentity: params.expectedSourceIdentity,
  });
  const { replacement } = source;
  let destFd: number | undefined;
  let closeRequiredForSuccess = false;
  try {
    if (params.restore === "restore-original") {
      const pinned = openPinnedDestinationSync(
        params.fsModule,
        params.dest,
        "restore",
        params.destinationHardlinks,
      );
      if (pinned !== null) {
        destFd = pinned;
        replacePinnedWithRestoreSync(
          params.fsModule,
          destFd,
          replacement,
          params.maxRestoreBytes!,
          source.mode,
          params.fchmodSync,
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
        source.mode & 0o777,
      );
      writeAllSync(params.fsModule, destFd, replacement);
      params.fchmodSync?.(destFd, source.mode);
      if (params.sync) {
        params.fsModule.fsyncSync(destFd);
      }
      closeRequiredForSuccess = !params.sync;
    }
  } finally {
    if (destFd !== undefined) {
      try {
        params.fsModule.closeSync(destFd);
      } catch (closeError) {
        if (closeRequiredForSuccess) {
          throw closeError;
        }
      }
    }
  }
}
