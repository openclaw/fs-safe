import { Transform } from "node:stream";
import { ArchiveFormatError } from "./archive-errors.js";
import type { AdmittedZipEntry } from "./archive-zip-entry.js";

import { updateCrc32 } from "./archive-crc32.js";

export function normalizeZipIntegrityError(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.includes("uncompressed data size mismatch")
  ) {
    return new ArchiveFormatError(`invalid ZIP entry data: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createZipIntegrityTransform(record: AdmittedZipEntry): Transform {
  const { entry, crc32: expectedCrc32, size: expectedSize } = record;

  let actualCrc32 = 0;
  let actualSize = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
      actualCrc32 = updateCrc32(actualCrc32, buffer);
      actualSize += buffer.byteLength;
      callback(null, buffer);
    },
    flush(callback) {
      if (actualSize !== expectedSize || actualCrc32 !== (expectedCrc32 >>> 0)) {
        callback(new ArchiveFormatError(`zip entry integrity check failed: ${entry.name}`));
        return;
      }
      callback();
    },
  });
}
