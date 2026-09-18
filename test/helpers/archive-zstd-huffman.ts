import { tarFixture } from "./archive-fuzz.js";
import { zstdBlock } from "./archive-zstd-block-limits.js";

export function huffmanFrame(blocks: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from("28b52ffd0008", "hex"), ...blocks]); // 2 KiB window.
}

export function huffmanZeroBlock(
  counts: readonly number[],
  { treeless = false, last = true, regeneratedSize = counts.reduce((sum, count) => sum + count, 0) } = {},
): Buffer {
  // Explicit weights 80 10 give zero and one a one-bit Huffman code. Each
  // stream contains exactly count zero bits followed by its own end marker.
  const streams = counts.map(count => {
    const bytes = Buffer.alloc(Math.floor(count / 8) + 1);
    bytes[bytes.length - 1] = 1 << (count % 8);
    return bytes;
  });
  const four = counts.length === 4;
  const jumps = Buffer.alloc(four ? 6 : 0);
  if (four) streams.slice(0, 3).forEach((stream, index) => jumps.writeUInt16LE(stream.length, index * 2));
  const literals = Buffer.concat([...(treeless ? [] : [Buffer.from([0x80, 0x10])]), jumps, ...streams]);
  const header = Buffer.alloc(four ? 4 : 3);
  header.writeUIntLE((treeless ? 3 : 2) + (four ? 8 : 0) + regeneratedSize * 16 + literals.length * 2 ** (four ? 18 : 14), 0, header.length);
  return zstdBlock(Buffer.concat([header, literals, Buffer.from([0])]), last, 2);
}

export function zeroTarWithHuffman(block: Buffer, size: number, prefixBlocks: readonly Buffer[] = []): Buffer {
  const tar = tarFixture([{ path: "value", body: Buffer.alloc(8) }]);
  return huffmanFrame([zstdBlock(tar.subarray(0, tar.length - size)), ...prefixBlocks, block]);
}

export function fourStreamTar(counts: readonly number[], treeless: boolean): Buffer {
  const prefix = treeless ? [huffmanZeroBlock([8, 8, 8, 8], { last: false })] : [];
  return zeroTarWithHuffman(huffmanZeroBlock(counts, { treeless }), counts.reduce((sum, count) => sum + count, 0) + (treeless ? 32 : 0), prefix);
}

// Table 81 11 assigns two-bit codes to zero and one, and a one-bit code to two.
// 04 contains the complete 00 code; 02 truncates it to one bit before the end marker.
export const completeSingleSymbol = Buffer.from("3d000012c00081110400", "hex");
export const truncatedSingleSymbol = Buffer.from("3d000012c00081110200", "hex");
