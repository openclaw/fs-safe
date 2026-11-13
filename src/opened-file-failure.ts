import fsSync, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { isFileObservationFailure, observedFilePublicationPending, recordFileObservationFailure } from "./file-observation.js";

export function recordFileOpenFailure(error: unknown, filePath: string): never {
  recordFileObservationFailure(error, `open:${filePath}`);
  throw error;
}

export function recordExclusiveCreateFailure(error: unknown, filePath: string): never {
  recordFileObservationFailure(error, `exclusive-create:${filePath}`);
  throw error;
}

export function openedPathResolutionError(
  error: Error = new FsSafeError("path-mismatch", "unable to resolve opened file path"),
): Error {
  recordFileObservationFailure(error, "resolution");
  return error;
}

export async function recordPreOpenFileChange(
  error: unknown,
  handle: FileHandle,
  filePath: string,
  before: BigIntStats | undefined,
  opened: BigIntStats | undefined,
): Promise<void> {
  if (!isFileObservationFailure(error, "identity") || !before?.isFile() || !opened?.isFile() ||
    ![0n, 1n].includes(before.nlink) || ![0n, 1n, 2n].includes(opened.nlink)) return;
  try {
    await inspectFileIdentity(async () => before);
    // A fresh exact descriptor distinguishes a completed handoff from a
    // still-linked generation that needs separate publication proof.
    const inspectCurrent = () => inspectFileIdentity(() => process.platform === "win32"
      ? fsSync.fstatSync(handle.fd, { bigint: true }) : handle.stat({ bigint: true }), opened);
    let current = await inspectCurrent();
    let publication = false;
    if (current.isFile() && current.nlink === 2n) {
      publication = await observedFilePublicationPending(filePath, current);
      current = await inspectCurrent();
    }
    if (current.isFile() && (before.dev !== current.dev || before.ino !== current.ino)) {
      // A stale pathname sample is not proof that its former inode was unlinked.
      if ([0n, 1n].includes(current.nlink)) recordFileObservationFailure(error, `changed:${filePath}`);
      else if (current.nlink === 2n && publication) recordFileObservationFailure(error, `linked-change:${filePath}`);
    }
  } catch {
    // Unknown, changed, or closed descriptor evidence never permits a discard.
  }
}

export async function recordOpenedFileFailure(
  error: unknown,
  handle: FileHandle,
  filePath: string,
  identity: BigIntStats,
): Promise<void> {
  if ((!isFileObservationFailure(error, "resolution") && !isFileObservationFailure(error, "identity")) ||
    !identity.isFile() || identity.nlink > 1n) return;
  try {
    const current = await inspectFileIdentity(() => process.platform === "win32"
      ? fsSync.fstatSync(handle.fd, { bigint: true }) : handle.stat({ bigint: true }), identity);
    if (current.isFile() && current.nlink === 0n) recordFileObservationFailure(error, `unlinked:${filePath}`);
  } catch {
    // A closed, changed, or unknown descriptor provides no retry evidence.
  }
}
