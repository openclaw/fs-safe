import fs from "node:fs/promises";
import path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function binaryMode(value: bigint): Buffer {
  const field = Buffer.alloc(8);
  field.writeBigUInt64BE(BigInt.asUintN(64, value));
  if (value >= 0) field[0] = 0x80;
  return field;
}

const fields = [
  { name: "blank NUL", field: Buffer.alloc(8), mode: undefined },
  { name: "blank spaces", field: Buffer.alloc(8, 0x20), mode: undefined },
  { name: "mixed blank padding", field: Buffer.from([0x20, 0, 0x20, 0, 0, 0, 0, 0]), mode: undefined },
  { name: "octal zero", field: Buffer.from("0000000\0"), mode: 0 },
  { name: "binary zero", field: binaryMode(0n), mode: 0 },
  { name: "binary executable", field: binaryMode(0o755n), mode: 0o755 },
  { name: "binary above u32", field: binaryMode(2n ** 32n + 0o755n), mode: 0o755 },
  { name: "binary max safe integer", field: binaryMode(2n ** 53n - 1n), mode: 0o777 },
  { name: "binary negative one", field: binaryMode(-1n), mode: 0o777 },
  { name: "binary negative readonly", field: binaryMode(-256n), mode: 0o400 },
  { name: "binary negative special bits", field: binaryMode(-512n), mode: 0 },
  { name: "binary min safe integer", field: binaryMode(-(2n ** 53n - 1n)), mode: 1 },
];
const routes = [
  { backend: "off", codec: "tar" }, { backend: "off", codec: "gzip" },
  ...(paxNative ? [{ backend: "require", codec: "tar" }, { backend: "require", codec: "gzip" }] : []),
  ...(paxNative && typeof zlib.zstdCompressSync === "function" ? [{ backend: "require", codec: "zstd" }] : []),
] as const;

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(routes)(
  "real non-root TAR fields $backend/$codec", ({ backend, codec }) => {
    it.each(fields)("preserves $name for regular, contiguous, directory and GNUDumpDir entries", async ({ field, mode }) => {
      configureFsSafeNative({ mode: backend as "off" | "require" });
      if (backend === "require") __setNativeLoaderForTest(() => paxNative!);
      const base = await tempRoot("fs-safe-tar-mode-fields-");
      const archivePath = path.join(base, "fixture.bin");
      const destDir = path.join(base, "out");
      await fs.mkdir(destDir);
      const entries = [
        { path: "file", type: "0" }, { path: "contiguous", type: "7" },
        { path: "directory/", type: "5" }, { path: "dump/", type: "D" },
      ];
      const tar = tarFixture(entries.map((entry) => ({
        ...entry, body: entry.type === "0" || entry.type === "7" ? "DATA" : "",
        mutateHeader: (header: Buffer) => { field.copy(header, 100); },
      })));
      const bytes = codec === "gzip" ? zlib.gzipSync(tar) : codec === "zstd" ? zlib.zstdCompressSync(tar) : tar;
      await fs.writeFile(archivePath, bytes);
      try {
        await extractArchive({ archivePath, destDir, kind: codec === "zstd" ? "tar-zstd" : "tar", tarGzip: codec === "gzip", entryModes: "preserve", timeoutMs: 10000 });
        for (const entry of entries) {
          const output = path.join(destDir, entry.path);
          const stat = await fs.stat(output);
          expect(stat.isDirectory()).toBe(entry.type === "5" || entry.type === "D");
          expect(stat.mode & 0o7777).toBe(mode ?? (stat.isDirectory() ? 0o755 : 0o644));
          if (stat.isFile()) {
            await fs.chmod(output, 0o600);
            expect(await fs.readFile(output, "utf8")).toBe("DATA");
          }
        }
      } finally {
        // Only owned synthetic fixtures are made traversable for cleanup, after mode inspection.
        for (const entry of entries) await fs.chmod(path.join(destDir, entry.path), 0o700).catch(() => undefined);
      }
    });
  },
);
