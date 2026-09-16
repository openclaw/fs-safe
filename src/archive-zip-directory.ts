import {
  assertArchiveEntryCountWithinLimit,
  type ResolvedArchiveExtractLimits,
} from "./archive-limits.js";
import { admitZipNames, zipExtraFields, zipFormat, zipUInt64 } from "./archive-zip-names.js";

export type ZipRead = { offset: number; length: number };
export type ZipScan = Generator<ZipRead, number, Buffer>;
export type ZipDirectoryEntry = {
  index: number;
  creatorSystem: number;
  externalAttributes: number;
  size: number;
  path?: string;
};

function* read(offset: number, length: number, bound: number): Generator<ZipRead, Buffer, Buffer> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > bound - offset) {
    zipFormat("record outside archive bounds");
  }
  const bytes = yield { offset, length };
  if (bytes.length !== length) zipFormat("truncated record");
  return bytes;
}

function endOffset(tail: Buffer): number {
  let found = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      if (found !== -1) zipFormat("ambiguous end records");
      found = offset;
    }
  }
  if (found < 0) zipFormat("end record missing");
  return found;
}

function* zip64End(locator: Buffer, locatorAt: number, size: number): Generator<ZipRead, { at: number; record: Buffer }, Buffer> {
  const advertised = zipUInt64(locator, 8);
  // Seek the advertised record, or the fixed ordinary record for a prefixed
  // archive. Never hunt through payload bytes for a ZIP64 signature.
  const candidates = new Set([advertised, locatorAt - 56]);
  let found: { at: number; record: Buffer } | undefined;
  for (const at of candidates) {
    if (at < 0 || at > locatorAt - 56) continue;
    const record = yield* read(at, 56, size);
    if (record.readUInt32LE(0) !== 0x06064b50) continue;
    const bodySize = zipUInt64(record, 4);
    if (bodySize < 44 || bodySize !== locatorAt - at - 12) continue;
    if (found) zipFormat("ambiguous ZIP64 end records");
    found = { at, record };
  }
  if (!found) zipFormat("unsupported ZIP64 end record");
  return found;
}

function* layout(size: number): Generator<ZipRead, { count: number; start: number; end: number; base: number }, Buffer> {
  const tailStart = Math.max(0, size - 65_557);
  const tail = yield* read(tailStart, size - tailStart, size);
  const at = endOffset(tail);
  const end = tail.subarray(at, at + 22);
  const physicalEnd = tailStart + at;
  if (end.readUInt16LE(4) || end.readUInt16LE(6)) zipFormat("multi-disk archive");
  let count = end.readUInt16LE(10);
  let directorySize = end.readUInt32LE(12);
  let offset = end.readUInt32LE(16);
  let directoryEnd = physicalEnd;
  const wide = count === 0xffff || end.readUInt16LE(8) === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff;
  if (wide) {
    const locator = yield* read(physicalEnd - 20, 20, size);
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) {
      zipFormat("invalid ZIP64 locator");
    }
    const wideEnd = yield* zip64End(locator, physicalEnd - 20, size);
    directoryEnd = wideEnd.at;
    const record = wideEnd.record;
    if (record.readUInt32LE(16) || record.readUInt32LE(20)) zipFormat("multi-disk ZIP64 archive");
    count = zipUInt64(record, 32);
    directorySize = zipUInt64(record, 40);
    offset = zipUInt64(record, 48);
    if (zipUInt64(record, 24) !== count) zipFormat("ZIP64 disk count mismatch");
    for (const [ordinary, sentinel, value] of [
      [end.readUInt16LE(8), 0xffff, count], [end.readUInt16LE(10), 0xffff, count],
      [end.readUInt32LE(12), 0xffffffff, directorySize], [end.readUInt32LE(16), 0xffffffff, offset],
    ]) {
      if (ordinary !== sentinel && ordinary !== value) zipFormat("conflicting ZIP64 end values");
    }
    const base = directoryEnd - directorySize - offset;
    if (zipUInt64(locator, 8) !== directoryEnd - base) zipFormat("ZIP64 locator offset mismatch");
  } else if (end.readUInt16LE(8) !== count) zipFormat("disk count mismatch");
  const start = directoryEnd - directorySize;
  const base = start - offset;
  if (base < 0 || start < 0 || !Number.isSafeInteger(base)) zipFormat("invalid central directory offset");
  return { count, start, end: directoryEnd, base };
}

function wideValues(header: Buffer, extra: Map<number, Buffer>, central: boolean) {
  let compressed = header.readUInt32LE(central ? 20 : 18);
  let uncompressed = header.readUInt32LE(central ? 24 : 22);
  let offset = central ? header.readUInt32LE(42) : 0;
  let disk = central ? header.readUInt16LE(34) : 0;
  const field = extra.get(1);
  if (field?.length === 0) zipFormat("empty ZIP64 extra field");
  let cursor = 0;
  const value = () => {
    if (!field) return zipFormat("ZIP64 extra field missing");
    const result = zipUInt64(field, cursor);
    cursor += 8;
    return result;
  };
  const wide = compressed === 0xffffffff || uncompressed === 0xffffffff;
  if (uncompressed === 0xffffffff) uncompressed = value();
  if (compressed === 0xffffffff) compressed = value();
  if (offset === 0xffffffff) offset = value();
  if (disk === 0xffff) {
    if (!field || cursor + 4 > field.length) zipFormat("ZIP64 disk field missing");
    disk = field.readUInt32LE(cursor);
    cursor += 4;
  }
  if (field && cursor !== field.length) {
    // Some writers repeat both local sizes even when the 32-bit fields fit.
    if (central || cursor !== 0 || field.length !== 16 ||
        zipUInt64(field, 0) !== uncompressed || zipUInt64(field, 8) !== compressed) {
      zipFormat("inconsistent ZIP64 extra field");
    }
  }
  if (disk) zipFormat("multi-disk entry");
  return { compressed, uncompressed, offset, wide };
}

function* descriptorEnd(at: number, bound: number, crc: number, compressed: number, uncompressed: number, wide: boolean): Generator<ZipRead, number, Buffer> {
  const length = wide ? 20 : 12;
  const bytes = yield* read(at, Math.min(length + 4, bound - at), bound);
  const matches: number[] = [];
  for (const skip of [0, 4]) {
    if (skip && (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x08074b50)) continue;
    if (bytes.length < length + skip || bytes.readUInt32LE(skip) !== crc) continue;
    const c = wide ? zipUInt64(bytes, skip + 4) : bytes.readUInt32LE(skip + 4);
    const u = wide ? zipUInt64(bytes, skip + 12) : bytes.readUInt32LE(skip + 8);
    if (c === compressed && u === uncompressed) matches.push(at + length + skip);
  }
  if (matches.length !== 1) zipFormat("invalid or ambiguous data descriptor");
  return matches[0]!;
}

export function* scanZipDirectory(
  size: number, limits: ResolvedArchiveExtractLimits, onEntry?: (entry: ZipDirectoryEntry) => void,
): ZipScan {
  const directory = yield* layout(size);
  assertArchiveEntryCountWithinLimit(directory.count, limits);
  const seen = new Set<string>();
  const spans: Array<{ start: number; end: number }> = [];
  let at = directory.start;
  let count = 0;
  while (at < directory.end) {
    const central = yield* read(at, Math.min(46, directory.end - at), directory.end);
    if (central.length >= 6 && central.readUInt32LE(0) === 0x05054b50) {
      // The optional digital signature belongs to the directory size, not its
      // entry count. It is opaque metadata, not an authenticity guarantee.
      if (central.readUInt16LE(4) !== directory.end - at - 6) zipFormat("invalid directory signature length");
      at = directory.end;
      break;
    }
    assertArchiveEntryCountWithinLimit(++count, limits);
    if (central.length < 46 || central.readUInt32LE(0) !== 0x02014b50) zipFormat("invalid central header");
    const nameLength = central.readUInt16LE(28);
    const extraLength = central.readUInt16LE(30);
    const next = at + 46 + nameLength + extraLength + central.readUInt16LE(32);
    if (next > directory.end) zipFormat("central record exceeds directory");
    const names = yield* read(at + 46, nameLength + extraLength, directory.end);
    const centralName = names.subarray(0, nameLength);
    const centralExtra = zipExtraFields(names.subarray(nameLength));
    const values = wideValues(central, centralExtra, true);
    const flags = central.readUInt16LE(8);
    if (flags & ~0x080e) zipFormat("unsupported entry flags");
    const localAt = directory.base + values.offset;
    if (localAt < directory.base) zipFormat("local offset precedes archive base");
    const local = yield* read(localAt, 30, directory.start);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== central.readUInt16LE(10)) {
      zipFormat("local and central framing disagree");
    }
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const localNames = yield* read(localAt + 30, localNameLength + localExtraLength, directory.start);
    const localExtra = zipExtraFields(localNames.subarray(localNameLength));
    const entryPath = admitZipNames({ central: centralName, local: localNames.subarray(0, localNameLength), flags, centralExtra, localExtra, seen });
    const localValues = wideValues(local, localExtra, false);
    const crc = central.readUInt32LE(16);
    if (!(flags & 8) && (local.readUInt32LE(14) !== crc || localValues.compressed !== values.compressed || localValues.uncompressed !== values.uncompressed)) {
      zipFormat("local and central sizes or CRC disagree");
    }
    if ((flags & 8) && ((local.readUInt32LE(14) !== 0 && local.readUInt32LE(14) !== crc) ||
        (localValues.compressed !== 0 && localValues.compressed !== values.compressed) ||
        (localValues.uncompressed !== 0 && localValues.uncompressed !== values.uncompressed))) {
      zipFormat("data descriptor placeholders disagree");
    }
    const dataStart = localAt + 30 + localNameLength + localExtraLength;
    if (values.compressed > directory.start - dataStart) zipFormat("entry data exceeds local area");
    let dataEnd = dataStart + values.compressed;
    if (flags & 8) dataEnd = yield* descriptorEnd(dataEnd, directory.start, crc, values.compressed, values.uncompressed, values.wide || localValues.wide);
    spans.push({ start: localAt, end: dataEnd });
    onEntry?.({
      index: count - 1, creatorSystem: central[5]!, externalAttributes: central.readUInt32LE(38),
      size: values.uncompressed, path: entryPath,
    });
    at = next;
  }
  if (count !== directory.count) zipFormat("physical and declared entry counts disagree");
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) zipFormat("overlapping local entries");
  }
  return count;
}
