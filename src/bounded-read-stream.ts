import { Transform } from "node:stream";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";

export function createMaxBytesTransform(maxBytes: number): Transform {
  normalizeMaxBytes(maxBytes);
  return createByteLimitTransform(maxBytes, (bytes) => new FsSafeError(
    "too-large",
    `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
  ));
}

export function createByteLimitTransform(
  maxBytes: number,
  overflowError: (bytes: number) => Error,
): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(overflowError(bytes));
        return;
      }
      callback(null, buffer);
    },
  });
}
