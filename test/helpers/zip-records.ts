import { deflateRawSync } from "node:zlib";

// Independent physical records: no JSZip writer or automatic parent directories.
export function fixtureCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipExtra(id: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id); header.writeUInt16LE(value.length, 2);
  return Buffer.concat([header, value]);
}

export function unicodePath(name: Buffer, value: string): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 1; header.writeUInt32LE(fixtureCrc32(name), 1);
  return zipExtra(0x7075, Buffer.concat([header, Buffer.from(value)]));
}

export type ZipRecord = {
  name: string | Buffer;
  localName?: string | Buffer;
  body?: string;
  attributes?: number;
  flags?: number;
  extra?: Buffer;
  localExtra?: Buffer;
  deflate?: boolean;
  descriptor?: boolean;
  zip64?: boolean;
};

export function zipRecords(entries: ZipRecord[], options: {
  prefix?: Buffer; comment?: Buffer; zip64?: boolean; declaredCount?: number;
  directorySignature?: Buffer; zip64ExtensibleData?: Buffer;
} = {}): Buffer {
  const localParts: Buffer[] = []; const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const localName = Buffer.from(entry.localName ?? name);
    const body = Buffer.from(entry.body ?? "payload");
    const compressed = entry.deflate ? deflateRawSync(body) : body;
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 8 : 0);
    const sizes = Buffer.alloc(16); sizes.writeBigUInt64LE(BigInt(body.length));
    sizes.writeBigUInt64LE(BigInt(compressed.length), 8);
    const wide = Buffer.alloc(24); sizes.copy(wide); wide.writeBigUInt64LE(BigInt(offset), 16);
    const extra = Buffer.concat([entry.zip64 ? zipExtra(1, wide) : Buffer.alloc(0), entry.extra ?? Buffer.alloc(0)]);
    const localExtra = Buffer.concat([entry.zip64 ? zipExtra(1, sizes) : Buffer.alloc(0), entry.localExtra ?? Buffer.alloc(0)]);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(entry.zip64 ? 45 : 20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(entry.descriptor ? 0 : fixtureCrc32(body), 14);
    local.writeUInt32LE(entry.zip64 ? 0xffffffff : entry.descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(entry.zip64 ? 0xffffffff : entry.descriptor ? 0 : body.length, 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor ? entry.zip64 ? 24 : 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(fixtureCrc32(body), 4);
      if (entry.zip64) {
        descriptor.writeBigUInt64LE(BigInt(compressed.length), 8);
        descriptor.writeBigUInt64LE(BigInt(body.length), 16);
      } else {
        descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(body.length, 12);
      }
    }
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4); central.writeUInt16LE(entry.zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(fixtureCrc32(body), 16);
    central.writeUInt32LE(entry.zip64 ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(entry.zip64 ? 0xffffffff : body.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.attributes ?? 0x81a40000, 38);
    central.writeUInt32LE(entry.zip64 ? 0xffffffff : offset, 42);
    localParts.push(local, localName, localExtra, compressed, descriptor);
    centralParts.push(central, name, extra);
    offset += local.length + localName.length + localExtra.length + compressed.length + descriptor.length;
  }
  if (options.directorySignature) {
    const header = Buffer.alloc(6); header.writeUInt32LE(0x05054b50);
    header.writeUInt16LE(options.directorySignature.length, 4);
    centralParts.push(header, options.directorySignature);
  }
  const directory = Buffer.concat(centralParts); const count = options.declaredCount ?? entries.length;
  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(options.zip64 ? 0xffff : count, 8); end.writeUInt16LE(options.zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16); end.writeUInt16LE(comment.length, 20);
  let wideEnd = Buffer.alloc(0);
  if (options.zip64) {
    wideEnd = Buffer.alloc(76); wideEnd.writeUInt32LE(0x06064b50);
    wideEnd.writeBigUInt64LE(44n, 4); wideEnd.writeUInt16LE(45, 12); wideEnd.writeUInt16LE(45, 14);
    wideEnd.writeBigUInt64LE(BigInt(count), 24); wideEnd.writeBigUInt64LE(BigInt(count), 32);
    wideEnd.writeBigUInt64LE(BigInt(directory.length), 40); wideEnd.writeBigUInt64LE(BigInt(offset), 48);
    wideEnd.writeUInt32LE(0x07064b50, 56); wideEnd.writeBigUInt64LE(BigInt(offset + directory.length), 64);
    wideEnd.writeUInt32LE(1, 72);
    if (options.zip64ExtensibleData) {
      wideEnd.writeBigUInt64LE(44n + BigInt(options.zip64ExtensibleData.length), 4);
      wideEnd = Buffer.concat([wideEnd.subarray(0, 56), options.zip64ExtensibleData, wideEnd.subarray(56)]);
    }
  }
  return Buffer.concat([options.prefix ?? Buffer.alloc(0), ...localParts, directory, wideEnd, end, comment]);
}
