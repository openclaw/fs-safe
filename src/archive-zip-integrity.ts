import { Transform } from "node:stream";
import { ArchiveFormatError } from "./archive-errors.js";
import type { ZipEntry } from "./archive-zip-entry.js";

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function updateCrc32(previous: number, buffer: Buffer): number {
  let crc = previous ^ -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ -1) >>> 0;
}

export function createZipIntegrityTransform(entry: ZipEntry): Transform {
  const expectedCrc32 = entry._data?.crc32;
  const expectedSize = entry._data?.uncompressedSize;
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
