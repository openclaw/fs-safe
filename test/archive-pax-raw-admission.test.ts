import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, inspectTarArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture, type TarFixtureEntry } from "./helpers/archive-fuzz.js";
import { paxHeader } from "./helpers/archive-pax.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const rejected: Array<{ label: string; entry: TarFixtureEntry; code: string }> = [
  { label: "raw UTF-8 before unsupported PAX type", code: "entry-path", entry: {
    path: "raw", type: "V", mutateHeader: (header) => { header[0] = 0xff; },
  } },
  { label: "raw NUL padding before unsupported PAX type", code: "entry-path", entry: {
    path: "raw", type: "V", mutateHeader: (header) => { header.write("raw\0hidden", 0); },
  } },
  { label: "link UTF-8 before link-presence and PAX policy", code: "entry-path", entry: {
    path: "raw", type: "V", mutateHeader: (header) => { header[157] = 0xff; },
  } },
  { label: "short-prefix NUL padding before PAX policy", code: "entry-path", entry: {
    path: "raw", type: "V", mutateHeader: (header) => { header[474] = 0x70; },
  } },
  { label: "wide-prefix UTF-8 before PAX policy", code: "entry-path", entry: {
    path: "raw", type: "V", mutateHeader: (header) => {
      header.fill(0x70, 345, 476);
      header[476] = 0xff;
    },
  } },
  { label: "missing raw link despite PAX linkpath", code: "archive-header-invalid", entry: {
    path: "raw", type: "2",
  } },
  { label: "raw link on a non-link", code: "archive-header-invalid", entry: {
    path: "raw", linkPath: "target",
  } },
  { label: "unsafe raw size despite effective zero", code: "archive-header-invalid", entry: {
    path: "raw", mutateHeader: (header) => {
      header.fill(0, 124, 136);
      header[124] = 0x80;
      header.writeBigUInt64BE(9_007_199_254_740_992n, 128);
    },
  } },
  { label: "raw directory size despite effective zero", code: "archive-header-invalid", entry: {
    path: "raw", type: "5", mutateHeader: (header) => { header.write("00000000001\0", 124, "ascii"); },
  } },
  { label: "raw backslash file suffix despite PAX path", code: "archive-header-invalid", entry: {
    path: "raw\\",
  } },
  { label: "unsupported PAX type before raw traversal policy", code: "archive-header-invalid", entry: {
    path: "../raw", type: "V",
  } },
];

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`PAX raw admission mode=${mode}`, () => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    });

    it.each(rejected)("preserves $label", async ({ entry, code }) => {
      const root = await tempRoot("fs-safe-pax-raw-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.mkdir(destDir);
      await fs.writeFile(archivePath, tarFixture([
        paxHeader([["path", "renamed"], ["size", "0"], ["linkpath", "target"]]), entry,
      ]));
      const entryFilter = vi.fn(() => "extract" as const);
      const options = { archivePath, timeoutMs: 10_000, entryFilter };
      const error = { code, name: code === "entry-path" ? "ArchiveSecurityError" : "ArchiveFormatError" };
      await expect(inspectTarArchive(options)).rejects.toMatchObject(error);
      await expect(extractArchive({ ...options, destDir })).rejects.toMatchObject(error);
      await expect(readArchiveEntry(archivePath, "renamed", { maxBytes: 1 })).rejects.toMatchObject(error);
      expect(entryFilter).not.toHaveBeenCalled();
      expect(await fs.readdir(destDir)).toEqual([]);
    });

    it("keeps the star prefix boundary when PAX replaces the raw name", async () => {
      const root = await tempRoot("fs-safe-pax-star-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.mkdir(destDir);
      await fs.writeFile(archivePath, tarFixture([
        paxHeader([["path", "renamed"], ["size", "7"]]),
        { path: "raw", body: "payload", mutateHeader: (header) => {
          header.fill(0x70, 345, 475);
          header[475] = 0;
          header.fill(0xff, 476, 500);
        } },
        { path: "sentinel", body: "end" },
      ]));
      const options = { archivePath, timeoutMs: 10_000 };
      await expect(inspectTarArchive(options)).resolves.toEqual([
        { path: "renamed", kind: "file", size: 7 },
        { path: "sentinel", kind: "file", size: 3 },
      ]);
      await extractArchive({ ...options, destDir });
      expect(await fs.readFile(path.join(destDir, "renamed"), "utf8")).toBe("payload");
      expect(await readArchiveEntry(archivePath, "renamed", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      expect(await readArchiveEntry(archivePath, "sentinel", { maxBytes: 3 })).toEqual(Buffer.from("end"));
    });
  });
}
