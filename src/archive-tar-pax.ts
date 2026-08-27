import { ArchiveFormatError } from "./archive-errors.js";

export type LocalPax = { path?: string; linkpath?: string; size?: number };

function invalid(): never {
  throw new ArchiveFormatError("invalid TAR header: unsupported or malformed PAX metadata");
}

function decimal(bytes: Buffer): number {
  const text = bytes.toString("latin1");
  if (!/^(0|[1-9][0-9]*)$/.test(text)) invalid();
  const value = Number(text);
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

function ascii(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.some((byte) => byte < 0x20 || byte > 0x7e)) invalid();
  return bytes.toString("ascii");
}

// Keep this grammar aligned with native/src/tar_pax.rs. Downstream parsers
// disagree on duplicates, coercions and UTF-8 chunk boundaries.
export function parseLocalPax(body: Buffer): LocalPax {
  if (body.length === 0) invalid();
  const result: LocalPax = {};
  const keys = new Set<string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) invalid();
    const length = decimal(body.subarray(offset, space));
    if (length > body.length - offset || length <= space - offset + 3) invalid();
    const end = offset + length;
    if (body[end - 1] !== 0x0a) invalid();
    const record = body.subarray(space + 1, end - 1);
    if (record.includes(0x0a)) invalid();
    const equals = record.indexOf(0x3d);
    if (equals <= 0) invalid();
    const key = ascii(record.subarray(0, equals));
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || keys.has(key)) invalid();
    keys.add(key);
    const value = record.subarray(equals + 1);
    if (/^(LIBARCHIVE|SCHILY)\.xattr\..+$/.test(key)) {
      // Inert bytes, never restored. Newlines would corrupt Rust's subsequent
      // record lookup; NUL and non-UTF8 bytes in these values are harmless.
    } else if (key === "path" || key === "linkpath") {
      result[key] = ascii(value);
    } else if (key === "size") {
      result.size = decimal(value);
    } else if (key === "uid" || key === "gid") {
      decimal(value);
    } else if (key === "uname" || key === "gname") {
      ascii(value);
    } else if (key === "mtime" || key === "atime" || key === "ctime") {
      const text = ascii(value);
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text) || Math.abs(Number(text)) > 8_640_000_000_000) invalid();
    } else {
      invalid();
    }
    offset = end;
  }
  return result;
}

function rawText(field: Buffer): string {
  const zero = field.indexOf(0);
  const value = field.subarray(0, zero < 0 ? field.length : zero);
  return value.length === 0 ? "" : ascii(value);
}

export function paxMemberSize(pax: LocalPax, type: number, rawSize: number, header: Buffer): number {
  if (![0, 0x30, 0x31, 0x32, 0x35, 0x37].includes(type)) invalid();
  const rawName = rawText(header.subarray(0, 100));
  const rawLink = rawText(header.subarray(157, 257));
  if (header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00"))) {
    rawText(header.subarray(345, 500));
  }
  const isLink = type === 0x31 || type === 0x32;
  if (isLink !== (rawLink.length > 0)) invalid();
  const size = pax.size ?? rawSize;
  if ([0x31, 0x32, 0x35].includes(type) && (rawSize !== 0 || size !== 0)) invalid();
  if (type !== 0x35 && (pax.path?.endsWith("/") || pax.path?.endsWith("\\") || rawName.endsWith("\\"))) invalid();
  if (pax.linkpath !== undefined && !isLink) invalid();
  return size;
}
