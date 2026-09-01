import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, isFileIdentityMismatch } from "./strict-file-identity.js";

const resolutionFailures = new WeakSet<Error>();
const openFailures = new WeakMap<Error, string>();
const unlinkedFailures = new WeakMap<Error, string>();

export function recordFileOpenFailure(error: unknown, filePath: string): never {
  if (error instanceof Error) openFailures.set(error, filePath);
  throw error;
}

export function isFileOpenFailure(error: unknown, filePath: string): boolean {
  return error instanceof Error && openFailures.get(error) === filePath;
}

export function openedPathResolutionError(
  error: Error = new FsSafeError("path-mismatch", "unable to resolve opened file path"),
): Error {
  resolutionFailures.add(error);
  return error;
}

export async function recordOpenedFileFailure(
  error: unknown,
  handle: FileHandle,
  filePath: string,
  identity: BigIntStats,
): Promise<void> {
  if (!(error instanceof Error) || (!resolutionFailures.has(error) && !isFileIdentityMismatch(error)) ||
    !identity.isFile() || identity.nlink > 1n) return;
  try {
    const current = await inspectFileIdentity(() => handle.stat({ bigint: true }), identity);
    if (current.isFile() && current.nlink === 0n) unlinkedFailures.set(error, filePath);
  } catch {
    // A closed, changed, or unknown descriptor provides no retry evidence.
  }
}

export function isUnlinkedFileFailure(error: unknown, filePath: string): boolean {
  return error instanceof Error && unlinkedFailures.get(error) === filePath;
}
