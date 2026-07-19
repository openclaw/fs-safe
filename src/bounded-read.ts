import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";

const READ_CHUNK_BYTES = 64 * 1024;

type ReadableFileHandle = Pick<FileHandle, "read">;

function assertMaxBytes(maxBytes: number): void {
  if (maxBytes === Number.POSITIVE_INFINITY) {
    return;
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer or Infinity");
  }
}

function createScratchBuffer(maxBytes: number): Buffer {
  const initialReadBytes = Number.isFinite(maxBytes)
    ? Math.min(READ_CHUNK_BYTES, maxBytes + 1)
    : READ_CHUNK_BYTES;
  return Buffer.allocUnsafe(Math.max(1, initialReadBytes));
}

function nextReadLength(total: number, maxBytes: number, capacity: number): number {
  return Number.isFinite(maxBytes)
    ? Math.min(capacity, maxBytes - total + 1)
    : capacity;
}

function appendChunk(params: {
  chunks: Buffer[];
  scratch: Buffer;
  bytesRead: number;
  total: number;
  maxBytes: number;
}): number {
  const total = params.total + params.bytesRead;
  if (total > params.maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got at least ${total})`,
    );
  }
  params.chunks.push(Buffer.from(params.scratch.subarray(0, params.bytesRead)));
  return total;
}

async function readBoundedAsync(
  maxBytes: number,
  readChunk: (scratch: Buffer, length: number) => Promise<number>,
): Promise<Buffer> {
  assertMaxBytes(maxBytes);
  const chunks: Buffer[] = [];
  const scratch = createScratchBuffer(maxBytes);
  let total = 0;
  while (true) {
    const length = nextReadLength(total, maxBytes, scratch.length);
    const bytesRead = await readChunk(scratch, length);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total = appendChunk({ chunks, scratch, bytesRead, total, maxBytes });
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
  return await readBoundedAsync(maxBytes, async (scratch, length) => {
    return (await handle.read(scratch, 0, length, null)).bytesRead;
  });
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
  return await readBoundedAsync(maxBytes, async (scratch, length) => {
    return await readDescriptorChunk(fd, scratch, length);
  });
}

/** Sync bounded read from a numeric descriptor. The caller owns the descriptor. */
export function readFileDescriptorBoundedSync(fd: number, maxBytes: number): Buffer {
  assertMaxBytes(maxBytes);
  const chunks: Buffer[] = [];
  const scratch = createScratchBuffer(maxBytes);
  let total = 0;
  while (true) {
    const length = nextReadLength(total, maxBytes, scratch.length);
    const bytesRead = fs.readSync(fd, scratch, 0, length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total = appendChunk({ chunks, scratch, bytesRead, total, maxBytes });
  }
}
