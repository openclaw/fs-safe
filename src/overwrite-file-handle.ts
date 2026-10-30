import fs from "node:fs";
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
  // Snapshot caller-owned admission before the first await. Preserve the
  // former method-call receiver while preventing a later getter mutation from
  // replacing authority after rollback preparation.
  const beforeWrite = options.beforeWrite;
  return overwrite(handle, data, options, beforeWrite);
}

/** Await authority preparation, then synchronously admit the whole borrowed-handle write. */
export async function overwriteFileHandleWithAuthority(
  handle: FileHandle,
  data: Uint8Array,
  prepareAuthority: () => Promise<() => void>,
): Promise<void> {
  if (typeof prepareAuthority !== "function") {
    throw new TypeError("prepareAuthority must be a function");
  }
  return overwrite(handle, data, undefined, undefined, prepareAuthority);
}

async function overwrite(
  handle: FileHandle,
  data: Uint8Array,
  receiver?: OverwriteFileHandleOptions,
  beforeWrite?: () => void,
  prepareAuthority?: () => Promise<() => void>,
): Promise<void> {
  const payload = data.subarray(0, data.byteLength);
  const payloadBytes = payload.byteLength;
  const fd = handle.fd;
  // The awaited API keeps metadata I/O off-thread; preserve the legacy fast path.
  const stat = prepareAuthority || fd < 0 ? await handle.stat() : fs.fstatSync(fd);
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
  if (prepareAuthority) {
    const assertCurrent = await prepareAuthority();
    if (typeof assertCurrent !== "function") {
      throw new TypeError("prepareAuthority must return a synchronous assertion");
    }
    assertSynchronousCallbackResult(assertCurrent(), "prepared authority assertion");
  } else {
    assertSynchronousCallbackResult(
      beforeWrite === undefined ? undefined : Reflect.apply(beforeWrite, receiver, []),
      "beforeWrite",
    );
  }

  let prefixStarted = false;
  try {
    // Leave existing bytes intact until any additional storage has been written.
    if (payloadBytes > originalSize) {
      await writeAllToFile(handle, payload.subarray(originalSize), { position: originalSize });
    }
    // An empty prepared write must dispatch truncation before yielding after admission.
    if (prefixBytes > 0 || !prepareAuthority) {
      prefixStarted = true;
      await writeAllToFile(handle, payload.subarray(0, prefixBytes), { position: 0 });
    }
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
