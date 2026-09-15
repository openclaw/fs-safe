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

const NO_CALLBACK_ARGUMENTS = Object.freeze([]);

function defineReceiverValue(
  receiver: Record<PropertyKey, unknown>,
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(receiver, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function copyTransferReceiver(
  options: CopyFileHandleOptions,
  maxBytes: number | undefined,
  sizeHint: number,
  signal: AbortSignal | undefined,
  onChunk: CopyFileHandleOptions["onChunk"],
  assertBeforeMutation: CopyFileHandleOptions["assertBeforeMutation"],
): Record<PropertyKey, unknown> {
  const receiver: Record<PropertyKey, unknown> = {};
  const spreadSource = Object(options) as CopyFileHandleOptions;
  // Preserve the former late object-spread boundary, including proxy traps and
  // unrelated getter failures. Authority-bearing values stay on their early
  // snapshots, while descriptors still run in original own-key order.
  for (const key of Reflect.ownKeys(spreadSource)) {
    if (!Object.getOwnPropertyDescriptor(spreadSource, key)?.enumerable) continue;
    let value: unknown;
    switch (key) {
      case "maxBytes": value = maxBytes; break;
      case "signal": value = signal; break;
      case "onChunk": value = onChunk; break;
      case "assertBeforeMutation": value = assertBeforeMutation; break;
      default: value = Reflect.get(spreadSource, key);
    }
    // Create a data property so an enumerable __proto__ key cannot alter the
    // ordinary receiver prototype, matching object spread.
    defineReceiverValue(receiver, key, value);
  }
  // Match the explicit fields that followed the former spread. Updating an
  // existing key retains its original position; absent keys append in order.
  defineReceiverValue(receiver, "maxBytes", maxBytes);
  defineReceiverValue(receiver, "sizeHint", sizeHint);
  defineReceiverValue(receiver, "targetPosition", 0);
  defineReceiverValue(receiver, "assertBeforeMutation", assertBeforeMutation);
  return receiver;
}

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
  const callbackThis = copyTransferReceiver(
    options, maxBytes, sizeHint, signal, onChunk, assertBeforeMutation,
  );
  const beforeWrite = signal == null
    ? assertBeforeMutation
    : assertBeforeMutation === undefined
      ? () => signal.throwIfAborted()
      : () => {
        signal.throwIfAborted();
        assertBeforeMutation();
      };
  return await transferFileHandleCore(
    source, target, sizeHint, maxBytes, 0,
    signal, onChunk, beforeWrite, callbackThis,
  ).catch(rethrowMutationAuthorityError);
}

// Root.copyIn supplies already-admitted identities and retains its owned target cursor.
export function transferFileHandle(
  source: FileHandle,
  target: FileHandle | number,
  options: CopyFileHandleOptions & { sizeHint: number; targetPosition?: number },
): Promise<number> {
  try {
    const maxBytes = options.maxBytes;
    const sizeHint = options.sizeHint;
    const targetPosition = options.targetPosition;
    const signal = options.signal;
    const onChunk = options.onChunk;
    const assertBeforeMutation = options.assertBeforeMutation;
    const beforeWrite = signal === undefined && assertBeforeMutation === undefined
      ? undefined
      : () => {
        signal?.throwIfAborted();
        if (assertBeforeMutation) {
          Reflect.apply(assertBeforeMutation, options, NO_CALLBACK_ARGUMENTS);
        }
      };
    return transferFileHandleCore(
      source, target, sizeHint, maxBytes, targetPosition,
      signal, onChunk, beforeWrite, options,
    );
  } catch (error) {
    // Keep the former async-function contract for synchronous option getters.
    return Promise.reject(error);
  }
}

async function transferFileHandleCore(
  source: FileHandle,
  target: FileHandle | number,
  sizeHint: number,
  maxBytes: number | undefined,
  targetPosition: number | undefined,
  signal: AbortSignal | undefined,
  onChunk: CopyFileHandleOptions["onChunk"],
  beforeWrite: CopyFileHandleOptions["assertBeforeMutation"],
  callbackThis: unknown,
): Promise<number> {
  const limit = maxBytes ?? Infinity;
  const buffer = Buffer.allocUnsafe(Math.min(512 * 1024, Math.max(64 * 1024, sizeHint), limit + 1));
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
    if (onChunk) {
      const returned: unknown = Function.prototype.call.call(onChunk, callbackThis, chunk);
      assertSynchronousCallbackResult(returned, "onChunk");
    }
    await writeAllToFile(target, chunk, {
      position: targetPosition === undefined ? undefined : targetPosition + position,
      assertBeforeMutation: beforeWrite,
    });
    position += bytesRead;
  }
}
