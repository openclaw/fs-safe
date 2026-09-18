// Fixed libzstd blocks keep these regressions independent of Node's optional
// zstd compressor API. The deliberately small-window containers are synthetic.
export function zstdBlock(payload: Buffer, last = false, type = 0, decodedSize = payload.length): Buffer {
  const header = Buffer.alloc(3);
  header.writeUIntLE((decodedSize << 3) | (type << 1) | Number(last), 0, 3);
  return Buffer.concat([header, payload]);
}

export function smallWindowFrame(blocks: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from("28b52ffd0000", "hex"), ...blocks]);
}

const expanded = Buffer.from("4d0000106161010083d3032c", "hex"); // 5,000 'a' bytes.
const middle = Buffer.from(expanded); middle[0]! &= 0xfe;

export const invalidZstdBlocks = [
  { name: "first final block", bytes: smallWindowFrame([expanded]) },
  { name: "non-final block", bytes: smallWindowFrame([middle, zstdBlock(Buffer.alloc(0), true)]) },
  { name: "after partial history", bytes: smallWindowFrame([zstdBlock(Buffer.alloc(50, 120)), expanded]) },
  { name: "after full history", bytes: smallWindowFrame([zstdBlock(Buffer.alloc(1024, 120)), expanded]) },
  { name: "middle block", bytes: smallWindowFrame([zstdBlock(Buffer.alloc(50, 120)), middle, zstdBlock(Buffer.alloc(50, 121), true)]) },
  { name: "RLE literals without sequences", bytes: smallWindowFrame([Buffer.from("2d0000cd5d006100", "hex")]) },
  { name: "impossible sequence count", bytes: smallWindowFrame([Buffer.from("2d00000081560001", "hex")]) },
  { name: "one byte over decoded block ceiling", bytes: smallWindowFrame([Buffer.from("4d00001061610100fc2b8005", "hex")]) },
  // A 128 MiB frame window does not permit a 128 KiB + 1 literal block.
  { name: "absolute 128 KiB decoded block ceiling", bytes: Buffer.from("28b52ffd00882d00001d00206100", "hex") },
];

export const validZstdBlocks = [
  { name: "encoder multi-block stream", bytes: Buffer.from("28b52ffd00004c00001061610100fb2b8005022000610220006102200061431c0061", "hex"), output: Buffer.alloc(5000, 97) },
  { name: "mixed raw blocks", bytes: smallWindowFrame([zstdBlock(Buffer.alloc(700, 97)), zstdBlock(Buffer.alloc(900, 98)), zstdBlock(Buffer.alloc(1000, 99), true)]), output: Buffer.concat([Buffer.alloc(700, 97), Buffer.alloc(900, 98), Buffer.alloc(1000, 99)]) },
  { name: "exact decoded block ceiling", bytes: smallWindowFrame([Buffer.from("4d00001061610100fb2b8005", "hex")]), output: Buffer.alloc(1024, 97) },
];

// A complete synthetic USTAR archive: value = 5,000 'a' bytes, valid two-block
// EOF. libzstd compressed it as one block; only the surrounding frame is changed.
export const zstdTarBlock = Buffer.from("3d0200840276616c756500303030303634343030303131363100303037303033002030007573746172003061000a0074805f0807f407012a8837a4068074dc0a3735027aacb466275004", "hex");
