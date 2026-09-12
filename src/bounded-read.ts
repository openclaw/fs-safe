import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";

const READ_CHUNK_BYTES = 64 * 1024;
// Preserve one-read performance through the default Root byte budget.
const MAX_INITIAL_READ_BYTES = 16 * 1024 * 1024;

type ReadableFileHandle = Pick<FileHandle, "read">;

function createInitialBuffer(maxBytes: number, size: number): Buffer {
  // A size hint can describe a huge sparse file or an already exhausted fd.
  return Buffer.allocUnsafe(Math.min(maxBytes, size, MAX_INITIAL_READ_BYTES) + 1);
}

function createScratchBuffer(maxBytes: number): Buffer {
  return Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
}

function growReadBuffer(buffer: Buffer, maxBytes: number): Buffer {
  // Grow only after consuming the whole buffer, never from an unchecked size hint.
  const capacity = Math.min(maxBytes + 1, Math.max(READ_CHUNK_BYTES, buffer.length * 2));
  const grown = Buffer.allocUnsafe(capacity);
  buffer.copy(grown);
  return grown;
}

function finishReadBuffer(buffer: Buffer, total: number): Buffer {
  if (total === 0) return Buffer.alloc(0);
  const result = buffer.subarray(0, total);
  return total < buffer.length / 2 ? Buffer.from(result) : result;
}

function addReadBytes(
  total: number,
  bytesRead: number,
  maxBytes: number,
  createLimitError?: () => Error,
): number {
  const next = total + bytesRead;
  if (next > maxBytes) {
    if (createLimitError) throw createLimitError();
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got at least ${next})`,
    );
  }
  return next;
}

export async function readBoundedAsync(
  maxBytes: number,
  readChunk: (scratch: Buffer, length: number) => Promise<number>,
  options: {
    observeRegularFileSize?: () => number | undefined;
    initialSize?: number;
    createLimitError?: () => Error;
  } = {},
): Promise<Buffer> {
  normalizeMaxBytes(maxBytes);
  let total = 0;
  const { observeRegularFileSize, createLimitError } = options;
  const size = options.initialSize ?? observeRegularFileSize?.();
  let buffer = size === undefined ? createScratchBuffer(maxBytes) : createInitialBuffer(maxBytes, size);
  if (size !== undefined) {
    const bytesRead = await readChunk(buffer, buffer.length);
    if (bytesRead === 0) return finishReadBuffer(buffer, 0);
    // Short reads can occur before EOF. Only use the size shortcut on this
    // initial read; virtual files can report zero or stale sizes thereafter.
    const currentSize = bytesRead < buffer.length ? observeRegularFileSize?.() : undefined;
    total = addReadBytes(total, bytesRead, maxBytes, createLimitError);
    if (currentSize !== undefined && bytesRead >= currentSize) return finishReadBuffer(buffer, total);
  }
  while (true) {
    if (total === buffer.length) buffer = growReadBuffer(buffer, maxBytes);
    const remaining = buffer.subarray(total);
    const bytesRead = await readChunk(remaining, remaining.length);
    if (bytesRead === 0) return finishReadBuffer(buffer, total);
    total = addReadBytes(total, bytesRead, maxBytes, createLimitError);
  }
}

/**
 * Reads from the handle's current offset without closing it. A bounded read
 * consumes at most maxBytes + 1 bytes so growth after an earlier stat cannot
 * force an unbounded allocation.
 */
export async function readFileHandleBounded(
  handle: ReadableFileHandle,
  maxBytes: number,
): Promise<Buffer> {
  normalizeMaxBytes(maxBytes);
  const fd = "fd" in handle && typeof handle.fd === "number" ? handle.fd : undefined;
  return await readBoundedAsync(maxBytes, async (scratch, length) => {
    return (await handle.read(scratch, 0, length, null)).bytesRead;
  }, { observeRegularFileSize: fd === undefined ? undefined : () => regularFileSize(fd) });
}

function regularFileSize(fd: number): number | undefined {
  try {
    const stat = fs.fstatSync(fd);
    return stat.isFile() && Number.isSafeInteger(stat.size) && stat.size >= 0
      ? stat.size : undefined;
  } catch {
    // Size is only an optimization hint; retain the reader's original errors.
    return undefined;
  }
}

function readDescriptorChunk(fd: number, scratch: Buffer, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, scratch, 0, length, null, (error, bytesRead) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(bytesRead);
    });
  });
}

/** Async bounded read from a numeric descriptor. The caller owns the descriptor. */
export async function readFileDescriptorBounded(fd: number, maxBytes: number): Promise<Buffer> {
  normalizeMaxBytes(maxBytes);
  return await readBoundedAsync(maxBytes, async (scratch, length) => {
    return await readDescriptorChunk(fd, scratch, length);
  }, { observeRegularFileSize: () => regularFileSize(fd) });
}

/** Sync bounded read from a numeric descriptor. The caller owns the descriptor. */
export function readFileDescriptorBoundedSync(fd: number, maxBytes: number): Buffer {
  normalizeMaxBytes(maxBytes);
  let total = 0;
  // Small budgets already bound the first allocation without a size lookup.
  const size = maxBytes <= READ_CHUNK_BYTES ? maxBytes : regularFileSize(fd);
  let buffer = size === undefined ? createScratchBuffer(maxBytes) : createInitialBuffer(maxBytes, size);
  if (size !== undefined) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) return finishReadBuffer(buffer, 0);
    const currentSize = bytesRead < buffer.length ? regularFileSize(fd) : undefined;
    total = addReadBytes(total, bytesRead, maxBytes);
    if (currentSize !== undefined && bytesRead >= currentSize) return finishReadBuffer(buffer, total);
  }
  while (true) {
    if (total === buffer.length) buffer = growReadBuffer(buffer, maxBytes);
    const remaining = buffer.subarray(total);
    const bytesRead = fs.readSync(fd, remaining, 0, remaining.length, null);
    if (bytesRead === 0) return finishReadBuffer(buffer, total);
    total = addReadBytes(total, bytesRead, maxBytes);
  }
}
