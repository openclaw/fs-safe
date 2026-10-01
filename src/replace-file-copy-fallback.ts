import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { inspectAtomicIdentity, runAsync, runSync, wait, type AtomicFile, type AtomicIo, type Procedure } from "./atomic-io.js";
import { readBoundedAsync, readBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { readOwnedCopySource } from "./replace-file-copy-source.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { hasErrorCode } from "./file-cleanup.js";
import { writeAtomicDestination } from "./replace-file-buffer.js";
import { AtomicMutation } from "./replace-file-mutation.js";
import { captureAtomicDestination, type AtomicDestination } from "./replace-file-destination.js";

export type ReplaceFileDestinationHardlinkPolicy = "reject";
export type ReplaceFileCopyFallbackRestorePolicy = "restore-original" | "none";
export type ReplaceFileAtomicRestoreCleanup = "restored" | "restore-failed";
export type ReplaceFileAtomicRestoreFailureDetails = {
  cleanup: ReplaceFileAtomicRestoreCleanup;
};

type DestinationAdmission = "restore" | "hardlinks";

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in syncFs.constants;
const NOFOLLOW = SUPPORTS_NOFOLLOW ? syncFs.constants.O_NOFOLLOW : 0;
const OPEN_READ_FLAGS = resolveReadOpenFlags();
const OPEN_READ_WRITE_FLAGS = syncFs.constants.O_RDWR | NOFOLLOW;
const OPEN_WRITE_EXCLUSIVE_FLAGS =
  syncFs.constants.O_WRONLY | syncFs.constants.O_CREAT | syncFs.constants.O_EXCL | NOFOLLOW;

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

function* openPinnedDestination(
  io: AtomicIo,
  dest: string,
  admission: DestinationAdmission,
  hardlinks?: ReplaceFileDestinationHardlinkPolicy,
  mutation?: AtomicMutation,
): Procedure<AtomicFile | null> {
  let preview: Stats;
  try {
    preview = yield* io.lstat(dest);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (io.asynchronous && !preview) return null;
  if (admission === "hardlinks" && (preview.isSymbolicLink() || !preview.isFile())) return null;
  if (admission === "restore" && preview.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${dest}`);
  }

  mutation?.assert();
  const file = yield* io.open(dest, admission === "restore" ? OPEN_READ_WRITE_FLAGS : OPEN_READ_FLAGS);
  try {
    const synchronous = io.asyncFs === fs;
    const openedInspection = inspectAtomicIdentity(io, () => file.statExact(), undefined, synchronous);
    const opened = (io.asynchronous && !synchronous ? (yield openedInspection) : openedInspection) as BigIntStats;
    const currentInspection = inspectAtomicIdentity(io, () => io.lstatExact(dest), opened, synchronous,
      stat => admitDestinationKind(stat, opened, dest, admission));
    if (io.asynchronous && !synchronous) yield currentInspection;
    if ((admission === "hardlinks" || hardlinks === "reject") && opened.nlink > 1n) {
      throw new FsSafeError("hardlink", `Hardlinked ${admission === "hardlinks" ? "atomic replace" : "copy fallback"} destination not allowed: ${dest}`);
    }
    return file;
  } catch (error) {
    try {
      const closing = file.close();
      if (io.asynchronous) yield closing;
    } catch {
      // Preserve the already-selected admission failure.
    }
    throw error;
  }
}

export function* assertDestinationHardlinkPolicy(
  io: AtomicIo,
  dest: string,
  policy?: ReplaceFileDestinationHardlinkPolicy,
): Procedure<void> {
  if (policy !== "reject") return;
  const file = yield* openPinnedDestination(io, dest, "hardlinks");
  if (!file) return;
  try {
    const closing = file.close();
    if (io.asynchronous) yield closing;
  } catch (error) {
    // Only asynchronous admission pins have best-effort successful close.
    if (!io.asynchronous) throw error;
  }
}

function* readRestoreSnapshot(
  io: AtomicIo,
  file: AtomicFile,
  maxBytes: number,
  stat: Stats,
): Procedure<Buffer> {
  let position = 0;
  function* read(buffer: Buffer, length: number): Procedure<number> {
    const result = file.read(buffer, 0, length, position);
    const bytesRead = io.asynchronous
      ? ((yield result) as { bytesRead: number }).bytesRead
      : result as number;
    position += bytesRead;
    return bytesRead;
  }
  const options = {
    initialSize: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : undefined,
    createLimitError: () => new FsSafeError("too-large", `Atomic replace restore snapshot exceeds maxRestoreBytes (${maxBytes})`),
  };
  return io.asynchronous
    ? yield* wait(readBoundedAsync(maxBytes, (buffer, length) => runAsync(read(buffer, length)), options))
    : readBoundedSync(maxBytes, (buffer, length) => runSync(read(buffer, length)), options);
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

function* replacePinnedWithRestore(
  io: AtomicIo,
  file: AtomicFile,
  replacement: Buffer,
  maxRestoreBytes: number,
  replacementMode: number,
  destination: AtomicDestination | undefined,
  mutation: AtomicMutation,
): Procedure<void> {
  const originalStat = yield* file.stat();
  const originalMode = originalStat.mode;
  const original = yield* readRestoreSnapshot(io, file, maxRestoreBytes, originalStat);
  try {
    yield* writeAtomicDestination(file, replacement, destination);
    if (destination) yield* destination.verify();
    const chmod = file.chmod(replacementMode);
    if (io.asynchronous) yield chmod;
    yield* file.sync();
  } catch (writeError) {
    mutation.rethrowRefusal();
    try {
      yield* writeAtomicDestination(file, original, destination, true);
      if (destination) yield* destination.verify(true);
      const chmod = file.chmod(originalMode);
      if (io.asynchronous) yield chmod;
      yield* file.sync();
      throw restoreFailure(writeError, "restored");
    } catch (restoreError) {
      mutation.rethrowRefusal();
      if (restoreError instanceof FsSafeError && restoreError.details?.cleanup === "restored") {
        throw restoreError;
      }
      throw restoreFailure(writeError, "restore-failed", restoreError);
    }
  }
}

export function* copyFallbackReplace(io: AtomicIo, params: {
  src: string;
  dest: string;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  restore: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  expectedSourceIdentity?: BigIntStats;
  sync: boolean;
  mutation?: AtomicMutation;
}): Procedure<void> {
  const mutation = params.mutation ?? new AtomicMutation({});
  const source = yield* readOwnedCopySource(io, {
    src: params.src,
    expectedIdentity: params.expectedSourceIdentity,
  });
  const { replacement } = source;
  let file: AtomicFile | null = null;
  let closeRequiredForSuccess = false;
  let completed = false;
  let destination: AtomicDestination | undefined;
  try {
    if (params.restore === "restore-original") {
      file = yield* openPinnedDestination(io, params.dest, "restore", params.destinationHardlinks, mutation);
      if (file) {
        if (mutation.active) {
          destination = yield* captureAtomicDestination(io, file, params.dest, mutation, params.destinationHardlinks === "reject");
        }
        yield* replacePinnedWithRestore(io, file, replacement, params.maxRestoreBytes!, source.mode, destination, mutation);
      }
    }

    if (!file) {
      let destStat: Stats | null = null;
      try {
        destStat = yield* io.lstat(params.dest);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      if (destStat?.isSymbolicLink()) {
        throw new FsSafeError("symlink", `Refusing copy fallback through symlink destination: ${params.dest}`);
      }
      if (destStat) {
        yield* assertDestinationHardlinkPolicy(io, params.dest, params.destinationHardlinks);
        mutation.assert();
        yield* io.remove(params.dest);
        mutation.removed(params.dest);
      }
      mutation.assert();
      file = yield* io.open(params.dest, OPEN_WRITE_EXCLUSIVE_FLAGS, source.mode & 0o777);
      if (mutation.active) {
        destination = yield* captureAtomicDestination(io, file, params.dest, mutation, params.destinationHardlinks === "reject");
        destination.writing();
      }
      if (destination || !io.asynchronous) {
        yield* writeAtomicDestination(file, replacement, destination);
        if (destination) yield* destination.verify();
      } else {
        yield file.writeFile(replacement);
      }
      const chmod = file.chmod(source.mode);
      if (io.asynchronous) yield chmod;
      if (params.sync) yield* file.sync();
      closeRequiredForSuccess = !params.sync;
    }
    if (destination) yield* destination.verify();
    destination?.published();
    completed = true;
  } finally {
    if (file) {
      try {
        const closing = file.close();
        if (io.asynchronous) yield closing;
      } catch (closeError) {
        if (closeRequiredForSuccess && completed) throw closeError;
      }
    }
  }
}
