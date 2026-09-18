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
import { tarFixture } from "./helpers/archive-fuzz.js";
import { invalidZstdBlocks, validZstdBlocks, smallWindowFrame, zstdBlock, zstdTarBlock } from "./helpers/archive-zstd-block-limits.js";
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

describe.each([1, 7, 65536])("portable zstd decoded block bounds (input=%i)", chunkSize => {
  it.each(invalidZstdBlocks)("rejects $name", async ({ bytes }) => {
    await expect(decode(bytes, chunkSize)).rejects.toMatchObject({ code: "archive-header-invalid" });
  });
  it.each(validZstdBlocks)("accepts $name without limiting total output to the history window", async ({ bytes, output }) => {
    expect(await decode(bytes, chunkSize)).toEqual(output);
  });
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`public zstd block boundaries ${mode}`, () => {
    function configure() {
      configureFsSafeNative({ mode });
      if (paxNative) __setNativeLoaderForTest(() => paxNative!);
    }
    it.each([0, 1, 2])("rejects an oversized decoded TAR block after %i headers before policy or publication", async prefixCount => {
      configure();
      const root = await tempRoot("fs-safe-zstd-block-limit-");
      const archivePath = path.join(root, "input.tar.zst"); const destDir = path.join(root, "out");
      const prefix = prefixCount ? tarFixture(Array.from({ length: prefixCount }, (_, i) => ({ path: `prefix-${i}`, body: "" })), false) : Buffer.alloc(0);
      const bytes = smallWindowFrame([...(prefix.length ? [zstdBlock(prefix)] : []), zstdTarBlock]);
      await fs.mkdir(destDir); await fs.writeFile(path.join(destDir, "sentinel"), "unchanged"); await fs.writeFile(archivePath, bytes);
      const filter = vi.fn(() => "extract" as const);
      const invalid = mode === "off" ? { code: "archive-header-invalid" }
        : { code: "GenericFailure", message: expect.stringContaining("Destination buffer is too small") };
      await expect(extractArchive({ archivePath, destDir, timeoutMs: 10_000, entryFilter: filter })).rejects.toMatchObject(invalid);
      expect(filter).not.toHaveBeenCalled();
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      await expect(readArchiveEntry(archivePath, "value", { maxBytes: 5000 })).rejects.toMatchObject(invalid);
    });
    it("extracts and reads valid multi-block TAR larger than its window", async () => {
      configure();
      const root = await tempRoot("fs-safe-zstd-valid-small-window-");
      const archivePath = path.join(root, "input.tar.zst"); const destDir = path.join(root, "out");
      const tar = tarFixture([{ path: "value", body: "a".repeat(5000) }]);
      const blocks: Buffer[] = [];
      for (let offset = 0; offset < tar.length; offset += 1024) blocks.push(zstdBlock(tar.subarray(offset, offset + 1024), offset + 1024 >= tar.length));
      await fs.mkdir(destDir); await fs.writeFile(archivePath, smallWindowFrame(blocks));
      await extractArchive({ archivePath, destDir, timeoutMs: 10_000 });
      expect(await fs.readFile(path.join(destDir, "value"))).toEqual(Buffer.alloc(5000, 97));
      expect(await readArchiveEntry(archivePath, "value", { maxBytes: 5000 })).toEqual(Buffer.alloc(5000, 97));
    });
  });
}
