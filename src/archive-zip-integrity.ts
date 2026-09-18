import { Transform } from "node:stream";
import { ArchiveFormatError } from "./archive-errors.js";
import {
  zipEntryIntegrityMetadata,
  type ZipEntry,
} from "./archive-zip-entry.js";

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

export function createZipIntegrityTransform(entry: ZipEntry): Transform {
  const metadata = zipEntryIntegrityMetadata(entry);
  const expectedCrc32 = metadata?.crc32;
  const expectedSize = metadata?.uncompressedSize;
  if (
    typeof expectedCrc32 !== "number" ||
    !Number.isInteger(expectedCrc32) ||
    typeof expectedSize !== "number" ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0
  ) {
    throw new ArchiveFormatError(`zip entry has invalid integrity metadata: ${entry.name}`);
  }

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
