import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function validateTarChecksum(header: Buffer): void {
  const field = header.subarray(148, 156);
  const end = field.indexOf(0);
  const digits = field.subarray(0, end < 0 ? field.length : end).toString("latin1").replace(/^ +| +$/g, "");
  const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
  // Require an in-field delimiter: node-tar otherwise reads into the typeflag.
  if (!/^[0-7]+$/.test(digits) || ![0, 32].includes(field[7]!) ||
      (end >= 0 && field.subarray(end).some((byte) => byte !== 0 && byte !== 32)) ||
      Number.parseInt(digits, 8) !== sum) {
    throw new ArchiveFormatError("invalid TAR header: checksum failure");
  }
}

function fixedField(field: Buffer): string {
  const zero = field.indexOf(0);
  if (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0)) {
    throw new ArchiveSecurityError("entry-path", "tar entry path contains bytes after NUL");
  }
  try {
    return utf8.decode(field.subarray(0, zero < 0 ? field.length : zero));
  } catch {
    throw new ArchiveSecurityError("entry-path", "tar entry path is not valid UTF-8");
  }
}

export function readTarHeaderPaths(header: Buffer): { name: string; prefix: string; linkname: string } {
  // node-tar's star layout uses a 130-byte prefix followed by atime/ctime.
  const prefixEnd = header[475] === 0 ? 475 : 500;
  return {
    name: fixedField(header.subarray(0, 100)),
    prefix: header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00"))
      ? fixedField(header.subarray(345, prefixEnd)) : "",
    linkname: fixedField(header.subarray(157, 257)),
  };
}

export function validateTarHeader(header: Buffer): void {
  validateTarChecksum(header);
  const { linkname } = readTarHeaderPaths(header);
  const isLink = header[156] === 0x31 || header[156] === 0x32;
  if (isLink && !linkname) {
    throw new ArchiveFormatError("invalid TAR header: linkname required on a link header");
  }
  if (!isLink && linkname) {
    throw new ArchiveFormatError("invalid TAR header: linkname forbidden on a non-link header");
  }
}
