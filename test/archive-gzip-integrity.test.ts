import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const compressed = gzipSync(tarFixture([{ path: "value.txt", body: "payload" }]));
const corruptChecksum = Buffer.from(compressed);
corruptChecksum[corruptChecksum.length - 8] ^= 1;
const damaged = [
  { name: "truncated DEFLATE body", bytes: compressed.subarray(0, Math.floor(compressed.length / 2)) },
  { name: "missing gzip trailer", bytes: compressed.subarray(0, -8) },
  { name: "corrupt gzip checksum", bytes: corruptChecksum },
];

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`gzip integrity ${mode}`, () => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    });

    async function fixture(bytes: Buffer) {
      const directory = await tempRoot("fs-safe-gzip-integrity-");
      const archivePath = path.join(directory, "fixture.tar.gz");
      const destDir = path.join(directory, "output");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, timeoutMs: 10_000 };
    }

    it("extracts and reads a complete gzip member", async () => {
      const options = await fixture(compressed);
      await extractArchive(options);
      expect(await fs.readFile(path.join(options.destDir, "value.txt"), "utf8")).toBe("payload");
      expect(await readArchiveEntry(options.archivePath, "value.txt", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
    });

    it.each(damaged)("rejects $name before publishing or returning entry bytes", async ({ bytes }) => {
      const options = await fixture(bytes);
      await expect(extractArchive(options)).rejects.toThrow();
      expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
      await expect(readArchiveEntry(options.archivePath, "value.txt", { maxBytes: 7 })).rejects.toThrow();
    });
  });
}
