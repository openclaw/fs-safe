import JSZip from "jszip";

export type TarSizeEncoding =
  | "octal"
  | "octal-max"
  | "base256"
  | "base256-u64-max"
  | "base256-high-bits"
  | "base256-negative"
  | "invalid-octal";

export type TarFixtureEntry = {
  path: string;
  body?: Buffer | string;
  mode?: number;
  type?: string;
  linkPath?: string;
  base256Size?: number;
  mutateHeader?: (header: Buffer) => void;
};

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function updateTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
}

export function tarFixture(
  entries: readonly TarFixtureEntry[],
  endBlocks = true,
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
    const type = entry.type ?? "0";
    const hasBody = ["0", "7", "K", "L", "g", "x"].includes(type);
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, entry.mode ?? (type === "5" ? 0o755 : 0o644));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    if (entry.base256Size === undefined) {
      writeOctal(header, 124, 12, hasBody ? body.length : 0);
    } else {
      header[124] = 0x80;
      header.writeBigUInt64BE(BigInt(entry.base256Size), 128);
    }
    writeOctal(header, 136, 12, 0);
    writeString(header, 156, 1, type);
    writeString(header, 157, 100, entry.linkPath ?? "");
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    entry.mutateHeader?.(header);
    updateTarChecksum(header);
    blocks.push(header);
    if (hasBody && entry.base256Size === undefined) {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  if (endBlocks) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function tarBytes(params: {
  name: string;
  body?: Buffer;
  declaredSize?: number;
  sizeEncoding?: TarSizeEncoding;
  truncateTo?: number;
}): Buffer {
  const body = params.body ?? Buffer.alloc(0);
  const declaredSize = params.declaredSize ?? body.byteLength;
  const encoding = params.sizeEncoding ?? "octal";
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, params.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 136, 12, 0);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");

  if (encoding === "octal") {
    writeOctal(header, 124, 12, declaredSize);
  } else if (encoding === "octal-max") {
    writeString(header, 124, 12, "77777777777\0");
  } else if (encoding === "base256") {
    header[124] = 0x80;
    header.writeBigUInt64BE(BigInt(declaredSize), 128);
  } else if (encoding === "base256-u64-max") {
    header[124] = 0x80;
    header.fill(0xff, 128, 136);
  } else if (encoding === "base256-high-bits") {
    header[124] = 0x80;
    header[125] = 1;
    header.writeBigUInt64BE(BigInt(declaredSize), 128);
  } else if (encoding === "base256-negative") {
    header.fill(0xff, 124, 136);
  } else {
    header.fill(0x38, 124, 136);
  }
  updateTarChecksum(header);

  const archive = Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.byteLength % 512)) % 512),
    Buffer.alloc(1024),
  ]);
  return params.truncateTo === undefined ? archive : archive.subarray(0, params.truncateTo);
}

export function tarEntriesBytes(
  entries: ReadonlyArray<{ name: string; body?: Buffer }>,
): Buffer {
  return tarFixture(entries.map(({ name, body }) => ({ path: name, body })));
}

export async function zipBytes(params: {
  names: readonly string[];
  body?: Buffer;
  truncateBy?: number;
  declaredSizeDelta?: number;
}): Promise<Buffer> {
  const zip = new JSZip();
  for (const [index, name] of params.names.entries()) {
    zip.file(name, params.body ?? Buffer.from(`entry-${index}`));
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  if (params.declaredSizeDelta) {
    const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (local >= 0 && central >= 0) {
      const size = bytes.readUInt32LE(local + 22) + params.declaredSizeDelta;
      bytes.writeUInt32LE(size, local + 22);
      bytes.writeUInt32LE(size, central + 24);
    }
  }
  return params.truncateBy
    ? bytes.subarray(0, Math.max(0, bytes.byteLength - params.truncateBy))
    : bytes;
}
