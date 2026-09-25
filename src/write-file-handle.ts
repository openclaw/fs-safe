import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { snapshotByteView } from "./byte-view.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";

const WRITE_CHUNK_BYTES = 512 * 1024;

export type WriteFileWindowOptions = {
  signal?: AbortSignal;
  /** Synchronous authority check immediately before every write, including short-write retries. */
  assertBeforeMutation?: () => void;
};

/** Write borrowed bytes completely; null advances the cursor, an explicit position preserves it. */
export async function writeFileWindowFully(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number | null,
  options: WriteFileWindowOptions = {},
): Promise<void> {
  const payload = snapshotByteView(bytes);
  if (position !== null && (!Number.isSafeInteger(position) || position < 0 ||
    !Number.isSafeInteger(position + payload.byteLength))) {
    throw new RangeError("write position and window end must be non-negative safe integers");
  }
  const signal = options.signal;
  const assertion = options.assertBeforeMutation;
  signal?.throwIfAborted();
  await writeAllToFile(handle, payload, {
    position: position === null ? undefined : position,
    assertBeforeMutation: () => {
      signal?.throwIfAborted();
      assertSynchronousCallbackResult(
        assertion === undefined ? undefined : Reflect.apply(assertion, options, []),
        "assertBeforeMutation",
      );
      signal?.throwIfAborted();
    },
  });
  // A pending write must settle before cancellation releases the caller's buffer and handle.
  signal?.throwIfAborted();
}

/** Private prefix length keeps admitted scratch windows on their original byte view. */
export async function writeAllToFile(
  target: FileHandle | number,
  data: string | Uint8Array,
  options?: {
    encoding?: BufferEncoding; position?: number; assertBeforeMutation?: () => void;
    createNoProgressError?: () => Error;
  },
  byteLength?: number,
): Promise<void> {
  const buffer = typeof data === "string" ? Buffer.from(data, options?.encoding ?? "utf8") : data;
  let offset = 0;
  while (offset < (byteLength ?? buffer.byteLength)) {
    const length = Math.min(WRITE_CHUNK_BYTES, (byteLength ?? buffer.byteLength) - offset);
    const position = options?.position === undefined ? null : options.position + offset;
    options?.assertBeforeMutation?.();
    const written = typeof target === "number"
      ? await new Promise<number>((resolve, reject) => {
        fs.write(target, buffer, offset, length, position, (error, bytesWritten) => {
          if (error) reject(error);
          else resolve(bytesWritten);
        });
      })
      : (await target.write(buffer, offset, length, position)).bytesWritten;
    if (written <= 0) {
      throw options?.createNoProgressError?.() ?? new FsSafeError("helper-failed", "file write made no progress");
    }
    offset += written;
  }
}
