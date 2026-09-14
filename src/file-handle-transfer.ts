import type { FileHandle } from "node:fs/promises";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import {
  assertSynchronousCallbackResult,
  composeMutationAssertions,
  rethrowMutationAuthorityError,
} from "./mutation-authority.js";
import { writeAllToFile } from "./write-file-handle.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

export type CopyFileHandleOptions = {
  maxBytes?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: Uint8Array) => void;
  assertBeforeMutation?: () => void;
};

/** Copies caller-owned regular files from offset zero without moving either cursor. */
export async function copyFileHandle(
  source: FileHandle,
  target: FileHandle,
  options: CopyFileHandleOptions = {},
): Promise<number> {
  options.signal?.throwIfAborted();
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const sourceStat = await inspectFileIdentity(() => {
    options.signal?.throwIfAborted();
    return source.stat({ bigint: true });
  });
  options.signal?.throwIfAborted();
  if (!sourceStat.isFile()) throw new FsSafeError("not-file", "copy source handle must be a regular file");
  if (maxBytes !== undefined && Number.isFinite(maxBytes) && sourceStat.size > BigInt(maxBytes)) {
    throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes`);
  }
  const targetStat = await inspectFileIdentity(() => {
    options.signal?.throwIfAborted();
    return target.stat({ bigint: true });
  });
  options.signal?.throwIfAborted();
  if (!targetStat.isFile()) throw new FsSafeError("not-file", "copy target handle must be a regular file");
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
    throw new FsSafeError("path-alias", "copy source and target handles refer to the same file");
  }
  return await transferFileHandle(source, target, {
    ...options,
    maxBytes,
    sizeHint: Number(sourceStat.size),
    targetPosition: 0,
    assertBeforeMutation: composeMutationAssertions(undefined, options.assertBeforeMutation),
  }).catch(rethrowMutationAuthorityError);
}

// Root.copyIn supplies already-admitted identities and retains its owned target cursor.
export async function transferFileHandle(
  source: FileHandle,
  target: FileHandle | number,
  options: CopyFileHandleOptions & { sizeHint: number; targetPosition?: number },
): Promise<number> {
  const maxBytes = options.maxBytes ?? Infinity;
  const buffer = Buffer.allocUnsafe(Math.min(512 * 1024, Math.max(64 * 1024, options.sizeHint), maxBytes + 1));
  let position = 0;
  while (true) {
    options.signal?.throwIfAborted();
    const { bytesRead } = await source.read(
      buffer, 0, Math.min(buffer.length, maxBytes - position + 1), position,
    );
    options.signal?.throwIfAborted();
    if (bytesRead > maxBytes - position) {
      throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes`);
    }
    if (bytesRead === 0) return position;
    const chunk = buffer.subarray(0, bytesRead);
    if (options.onChunk) assertSynchronousCallbackResult(options.onChunk(chunk), "onChunk");
    await writeAllToFile(target, chunk, {
      position: options.targetPosition === undefined ? undefined : options.targetPosition + position,
      assertBeforeMutation: () => {
        options.signal?.throwIfAborted();
        options.assertBeforeMutation?.();
      },
    });
    position += bytesRead;
  }
}
