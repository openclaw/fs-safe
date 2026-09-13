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
  // Snapshot caller-owned options before the first await. This preserves
  // inherited/non-enumerable callbacks and prevents accessor mutation from
  // replacing cancellation or mutation authority mid-transfer.
  const signal = options.signal;
  signal?.throwIfAborted();
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const onChunk = options.onChunk;
  const assertBeforeMutation = composeMutationAssertions(
    undefined,
    options.assertBeforeMutation,
  );
  const sourceStat = await inspectFileIdentity(() => {
    signal?.throwIfAborted();
    return source.stat({ bigint: true });
  });
  signal?.throwIfAborted();
  if (!sourceStat.isFile()) throw new FsSafeError("not-file", "copy source handle must be a regular file");
  if (maxBytes !== undefined && Number.isFinite(maxBytes) && sourceStat.size > BigInt(maxBytes)) {
    throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes`);
  }
  const targetStat = await inspectFileIdentity(() => {
    signal?.throwIfAborted();
    return target.stat({ bigint: true });
  });
  signal?.throwIfAborted();
  if (!targetStat.isFile()) throw new FsSafeError("not-file", "copy target handle must be a regular file");
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
    throw new FsSafeError("path-alias", "copy source and target handles refer to the same file");
  }
  const sizeHint = Number(sourceStat.size);
  const onChunkThis = onChunk ? {
    maxBytes, sizeHint, targetPosition: 0, assertBeforeMutation, signal, onChunk,
  } : undefined;
  return await transferFileHandleCore(
    source, target, sizeHint, maxBytes, 0,
    signal, onChunk, assertBeforeMutation, onChunkThis,
  ).catch(rethrowMutationAuthorityError);
}

// Root.copyIn supplies already-admitted identities and retains its owned target cursor.
export async function transferFileHandle(
  source: FileHandle,
  target: FileHandle | number,
  options: CopyFileHandleOptions & { sizeHint: number; targetPosition?: number },
): Promise<number> {
  const maxBytes = options.maxBytes;
  const sizeHint = options.sizeHint;
  const targetPosition = options.targetPosition;
  const signal = options.signal;
  const onChunk = options.onChunk;
  const assertBeforeMutation = options.assertBeforeMutation;
  return await transferFileHandleCore(
    source, target, sizeHint, maxBytes, targetPosition,
    signal, onChunk, assertBeforeMutation, options,
  );
}

async function transferFileHandleCore(
  source: FileHandle,
  target: FileHandle | number,
  sizeHint: number,
  maxBytes: number | undefined,
  targetPosition: number | undefined,
  signal: AbortSignal | undefined,
  onChunk: CopyFileHandleOptions["onChunk"],
  assertBeforeMutation: CopyFileHandleOptions["assertBeforeMutation"],
  onChunkThis: unknown,
): Promise<number> {
  const limit = maxBytes ?? Infinity;
  const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(64 * 1024, sizeHint)));
  const beforeWrite = signal === undefined && assertBeforeMutation === undefined
    ? undefined
    : () => {
      signal?.throwIfAborted();
      assertBeforeMutation?.();
    };
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await source.read(
      buffer, 0, Math.min(buffer.length, limit - position + 1), position,
    );
    signal?.throwIfAborted();
    if (bytesRead > limit - position) {
      throw new FsSafeError("too-large", `file exceeds limit of ${limit} bytes`);
    }
    if (bytesRead === 0) return position;
    const chunk = buffer.subarray(0, bytesRead);
    if (onChunk) assertSynchronousCallbackResult(Reflect.apply(onChunk, onChunkThis, [chunk]), "onChunk");
    await writeAllToFile(target, chunk, {
      position: targetPosition === undefined ? undefined : targetPosition + position,
      assertBeforeMutation: beforeWrite,
    });
    position += bytesRead;
  }
}
