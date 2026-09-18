import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortableTarDecoder } from "../src/archive-codec-wasm.js";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { completeSingleSymbol, fourStreamTar, huffmanFrame, huffmanZeroBlock, truncatedSingleSymbol, zeroTarWithHuffman } from "./helpers/archive-zstd-huffman.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

async function decode(bytes: Buffer, chunkSize: number): Promise<Buffer> {
  const output: Buffer[] = [];
  await pipeline(Readable.from((function* () {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  })()), createPortableTarDecoder("tar-zstd", 100_000),
  new Writable({ write(chunk: Buffer, _encoding, done) { output.push(chunk); done(); } }));
  return Buffer.concat(output);
}

const validArchives = [false, true].flatMap(treeless => {
  const segment = treeless ? 376 : 384;
  return [0, 1, 2, 3].map(remainder => ({
    name: `${treeless ? "treeless" : "compressed"} fourth stream shorter by ${remainder}`,
    bytes: fourStreamTar([segment, segment, segment, segment - remainder], treeless),
  }));
});
validArchives.push({ name: "single complete two-bit symbol", bytes: zeroTarWithHuffman(completeSingleSymbol, 1) });

// These larger redistributions are independently rejected by native libzstd;
// its fast decoder tolerates some smaller malformed shifts used below.
const invalidArchives = [false, true].flatMap(treeless => {
  const segment = treeless ? 376 : 384;
  const excess = treeless ? 256 : 32;
  return [
    { name: `${treeless ? "treeless" : "compressed"} first stream too long`, counts: [segment + excess, segment, segment, segment - excess] },
    { name: `${treeless ? "treeless" : "compressed"} first stream too short`, counts: [1, segment * 2 - 1, segment, segment] },
  ].map(({ name, counts }) => ({ name, bytes: fourStreamTar(counts, treeless) }));
});
invalidArchives.push({ name: "single truncated two-bit symbol", bytes: zeroTarWithHuffman(truncatedSingleSymbol, 1) });

describe.each([1, 7, 65536])("portable zstd Huffman streams (input=%i)", chunkSize => {
  it.each([false, true])("preserves exact individual counts with reused table=%s", async treeless => {
    const prefix = treeless ? [huffmanZeroBlock([8, 8, 8, 8], { last: false })] : [];
    for (const remainder of [0, 1, 2, 3]) {
      const counts = [64, 64, 64, 64 - remainder];
      const bytes = huffmanFrame([...prefix, huffmanZeroBlock(counts, { treeless })]);
      expect(await decode(bytes, chunkSize)).toEqual(Buffer.alloc(256 - remainder + (treeless ? 32 : 0)));
    }
    for (const stream of [0, 1, 2, 3]) {
      for (const shift of [-1, 1]) {
        const counts = [64, 64, 64, 64];
        counts[stream]! += shift; counts[(stream + 1) % 4]! -= shift;
        await expect(decode(huffmanFrame([...prefix, huffmanZeroBlock(counts, { treeless })]), chunkSize))
          .rejects.toMatchObject({ code: "archive-header-invalid" });
      }
    }
  });
  it.each([{ counts: [1, 0, 0, 0] }, { counts: [1, 1, 0, 0] }, { counts: [2, 1, 1, 1] }])("rejects impossible fourth-stream remainder $counts", async ({ counts }) => {
    await expect(decode(huffmanFrame([huffmanZeroBlock(counts)]), chunkSize)).rejects.toMatchObject({ code: "archive-header-invalid" });
  });
  it("bounds single-stream output and rejects partial final symbols", async () => {
    expect(await decode(huffmanFrame([completeSingleSymbol]), chunkSize)).toEqual(Buffer.from([0]));
    expect(await decode(huffmanFrame([huffmanZeroBlock([64])]), chunkSize)).toEqual(Buffer.alloc(64));
    for (const block of [truncatedSingleSymbol, huffmanZeroBlock([4096], { regeneratedSize: 1 }), huffmanZeroBlock([63], { regeneratedSize: 64 })]) {
      await expect(decode(huffmanFrame([block]), chunkSize)).rejects.toMatchObject({ code: "archive-header-invalid" });
    }
  });
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`public zstd Huffman integrity ${mode}`, () => {
    function configure() {
      configureFsSafeNative({ mode });
      if (paxNative) __setNativeLoaderForTest(() => paxNative!);
    }
    it.each(invalidArchives)("rejects $name before policy or publication", async ({ bytes }) => {
      configure();
      const root = await tempRoot("fs-safe-huffman-invalid-");
      const archivePath = path.join(root, "input.tar.zst"), destDir = path.join(root, "out");
      await fs.mkdir(destDir); await fs.writeFile(path.join(destDir, "sentinel"), "unchanged"); await fs.writeFile(archivePath, bytes);
      const filter = vi.fn(() => "extract" as const);
      const invalid = mode === "off" ? { code: "archive-header-invalid" }
        : { code: "GenericFailure", message: expect.stringContaining("Data corruption detected") };
      await expect(extractArchive({ archivePath, destDir, timeoutMs: 10_000, entryFilter: filter })).rejects.toMatchObject(invalid);
      expect(filter).not.toHaveBeenCalled();
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      await expect(readArchiveEntry(archivePath, "value", { maxBytes: 8 })).rejects.toMatchObject(invalid);
    });
    it.each(validArchives)("extracts and reads $name", async ({ bytes }) => {
      configure();
      const root = await tempRoot("fs-safe-huffman-valid-");
      const archivePath = path.join(root, "input.tar.zst"), destDir = path.join(root, "out");
      await fs.mkdir(destDir); await fs.writeFile(archivePath, bytes);
      await extractArchive({ archivePath, destDir, timeoutMs: 10_000 });
      expect(await fs.readFile(path.join(destDir, "value"))).toEqual(Buffer.alloc(8));
      expect(await readArchiveEntry(archivePath, "value", { maxBytes: 8 })).toEqual(Buffer.alloc(8));
    });
  });
}
