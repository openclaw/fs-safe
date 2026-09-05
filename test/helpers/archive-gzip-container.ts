import { deflateRawSync } from "node:zlib";
import { tarFixture } from "./archive-fuzz.js";

// Independent RFC 1952 construction: raw DEFLATE plus explicit CRC32/ISIZE.
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function gzipMember(bytes: Buffer, optionalHeader = false): Buffer {
  let header: Buffer = Buffer.from([31, 139, 8, optionalHeader ? 30 : 0, 0, 0, 0, 0, 0, 255]);
  if (optionalHeader) {
    header = Buffer.concat([header, Buffer.from([3, 0, 0, 255, 10]), Buffer.from("name\0comment\0")]);
    const checksum = Buffer.alloc(2);
    checksum.writeUInt16LE(crc32(header) & 0xffff);
    header = Buffer.concat([header, checksum]);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes));
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([header, deflateRawSync(bytes), trailer]);
}
export function sizedGzipMember(bytes: Buffer, size: number): Buffer {
  const member = gzipMember(bytes);
  const extraLength = size - member.length - 2;
  if (extraLength < 0 || extraLength > 0xffff) throw new RangeError("invalid gzip extra length");
  const header = Buffer.from(member.subarray(0, 10));
  header[3] |= 4;
  const length = Buffer.alloc(2);
  length.writeUInt16LE(extraLength);
  return Buffer.concat([header, length, Buffer.alloc(extraLength), member.subarray(10)]);
}
export const gzipTar = tarFixture([{ path: "value", body: "payload" }, { path: "sentinel", body: "end" }]);
export const completeGzip = gzipMember(gzipTar);
const corrupt = (bytes: Buffer, offset: number) => {
  const result = Buffer.from(bytes); result[offset] ^= 1; return result;
};
const empty = gzipMember(Buffer.alloc(0));
export const invalidGzipContainers: Array<[string, Buffer]> = [
  ["nonzero immediately after member", Buffer.concat([completeGzip, Buffer.from([1])])],
  ...[1, 511, 512, 513, 65536, 131072].map((size): [string, Buffer] =>
    [`nonzero after ${size} zeros`, Buffer.concat([completeGzip, Buffer.alloc(size), Buffer.from([1])])]),
  ["member after padding", Buffer.concat([completeGzip, Buffer.alloc(1), empty])],
  ...[65534, 65535].map((size): [string, Buffer] =>
    [`empty member in a later chunk after padding at ${size}`, Buffer.concat([
      sizedGzipMember(gzipTar, size), Buffer.alloc(65536 - size), empty,
    ])]),
  ["incomplete following magic", Buffer.concat([completeGzip, Buffer.from([31])])],
  ["incomplete following header", Buffer.concat([completeGzip, Buffer.from([31, 139, 8])])],
  ["bad following header", Buffer.concat([completeGzip, Buffer.from([31, 139, 0, 0, 0, 0, 0, 0, 0, 0])])],
  ["bad second CRC", Buffer.concat([completeGzip, corrupt(empty, empty.length - 8)])],
  ["truncated second trailer", Buffer.concat([completeGzip, empty.subarray(0, -3)])],
  ...[false, true].flatMap((padding): Array<[string, Buffer]> => {
    const tail = padding ? Buffer.alloc(10240) : Buffer.alloc(0);
    return [
      ["truncated body", completeGzip.subarray(0, Math.floor(completeGzip.length / 2))],
      ["missing trailer", completeGzip.subarray(0, -8)],
      ["truncated CRC", completeGzip.subarray(0, -6)],
      ["missing ISIZE", completeGzip.subarray(0, -4)],
      ["bad CRC", corrupt(completeGzip, completeGzip.length - 8)],
      ["bad ISIZE", corrupt(completeGzip, completeGzip.length - 4)],
      ["bad method", corrupt(completeGzip, 2)],
      ["bad header CRC", corrupt(gzipMember(gzipTar, true), 10)],
    ].map(([name, bytes]) => [`${name}, padding=${padding}`, Buffer.concat([bytes as Buffer, tail])]);
  }),
];
