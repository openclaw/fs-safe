import { Transform } from "node:stream";
import { FsSafeError } from "./errors.js";

export function createMaxBytesTransform(maxBytes: number): Transform {
  if (
    maxBytes !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    throw new RangeError("maxBytes must be a non-negative safe integer or Infinity");
  }
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(
          new FsSafeError(
            "too-large",
            `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
          ),
        );
        return;
      }
      callback(null, buffer);
    },
  });
}

export function createBoundedReadStream(
  opened: { handle: { createReadStream(): NodeJS.ReadableStream } },
  maxBytes: number | undefined,
): NodeJS.ReadableStream {
  const stream = opened.handle.createReadStream();
  return maxBytes === undefined ? stream : stream.pipe(createMaxBytesTransform(maxBytes));
}
