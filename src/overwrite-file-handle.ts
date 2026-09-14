import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { readFileWindowFully } from "./positional-read.js";
import { writeAllToFile } from "./write-file-handle.js";

export type OverwriteFileHandleOptions = {
  /** Admit the whole write once, after rollback preparation and before any mutation. */
  beforeWrite?: () => void;
};

/** Overwrite a borrowed, non-append read/write handle with best-effort failure rollback. */
export async function overwriteFileHandle(
  handle: FileHandle,
  data: Uint8Array,
  options: OverwriteFileHandleOptions = {},
): Promise<void> {
  const payload = data.subarray(0, data.byteLength);
  const payloadBytes = payload.byteLength;
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", "overwrite handle must be a regular file");
  }
  const originalSize = stat.size;
  if (!Number.isSafeInteger(originalSize) || originalSize < 0) {
    throw new RangeError("file size must be a non-negative safe integer");
  }
  const prefixBytes = Math.min(payloadBytes, originalSize);
  const originalPrefix = Buffer.allocUnsafe(prefixBytes);
  if (await readFileWindowFully(handle, originalPrefix, 0) !== prefixBytes) {
    throw new FsSafeError("read-failed", "file ended before overwrite rollback preparation completed");
  }
  assertSynchronousCallbackResult(options.beforeWrite?.(), "beforeWrite");

  let prefixStarted = false;
  try {
    // Leave existing bytes intact until any additional storage has been written.
    if (payloadBytes > originalSize) {
      await writeAllToFile(handle, payload.subarray(originalSize), { position: originalSize });
    }
    prefixStarted = true;
    await writeAllToFile(handle, payload.subarray(0, prefixBytes), { position: 0 });
    if (payloadBytes < originalSize) {
      await handle.truncate(payloadBytes);
    }
  } catch (error) {
    if (prefixStarted) {
      await writeAllToFile(handle, originalPrefix, { position: 0 }).catch(() => undefined);
    }
    await handle.truncate(originalSize).catch(() => undefined);
    throw error;
  }
}
