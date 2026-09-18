import { Transform } from "node:stream";

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
