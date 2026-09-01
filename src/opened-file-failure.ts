import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { isFileObservationFailure, recordFileObservationFailure } from "./file-observation.js";

export function recordFileOpenFailure(error: unknown, filePath: string): never {
  recordFileObservationFailure(error, `open:${filePath}`);
  throw error;
}

export function openedPathResolutionError(
  error: Error = new FsSafeError("path-mismatch", "unable to resolve opened file path"),
): Error {
  recordFileObservationFailure(error, "resolution");
  return error;
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
    const current = await inspectFileIdentity(() => handle.stat({ bigint: true }), identity);
    if (current.isFile() && current.nlink === 0n) recordFileObservationFailure(error, `unlinked:${filePath}`);
  } catch {
    // A closed, changed, or unknown descriptor provides no retry evidence.
  }
}
