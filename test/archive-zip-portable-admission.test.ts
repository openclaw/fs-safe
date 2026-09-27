import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";
import { unicodePath, zipRecords, type ZipRecord } from "./helpers/zip-records.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); });

const collisions: Array<[string, ZipRecord[]]> = [
  ["ASCII case", [{ name: "Payload" }, { name: "payload" }]],
  ["flagged UTF-8 normalization", [{ name: "caf\u00e9", flags: 0x800 }, { name: "cafe\u0301", flags: 0x800 }]],
  ["Unicode overrides", [
    { name: "first", extra: unicodePath(Buffer.from("first"), "CAF\u00c9") },
    { name: "second", extra: unicodePath(Buffer.from("second"), "cafe\u0301") },
  ]],
  ["directory case", [{ name: "Folder/" }, { name: "folder/" }]],
];

describe("ZIP portable collisions before member selection", () => {
  it("checks legacy names after the portable decoder's name interpretation", async () => {
    await expect(loadZipArchiveWithPreflight(zipRecords([
      { name: "CAF\u00c9" }, { name: "cafe\u0301" },
    ]))).rejects.toMatchObject({ code: "entry-path" });
  });

  it.skipIf(!native)("checks native CP437 names before returning an unrelated member", async () => {
    configureFsSafeNative({ mode: "require" });
    const root = await tempRoot("fs-safe-zip-legacy-collision-");
    const archivePath = path.join(root, "input.zip");
    await fs.writeFile(archivePath, zipRecords([
      { name: "good", body: "safe" },
      { name: Buffer.from([0x82]) }, { name: Buffer.from([0x90]) },
    ]));
    await expect(readArchiveEntry(archivePath, "good", { maxBytes: 4 }))
      .rejects.toMatchObject({ code: "entry-path" });
  });

  it.each(collisions)("rejects %s in public preflight", async (_label, records) => {
    await expect(loadZipArchiveWithPreflight(zipRecords(records)))
      .rejects.toMatchObject({ code: "entry-path" });
  });

  for (const mode of ["off", "require"] as const) {
    describe.skipIf(mode === "require" && !native)(mode, () => {
      it.each(collisions)("rejects %s before reads, filters, or stripping", async (_label, records) => {
        configureFsSafeNative({ mode });
        const root = await tempRoot("fs-safe-zip-portable-admission-");
        const archivePath = path.join(root, "input.zip");
        const destDir = path.join(root, "destination");
        await fs.mkdir(destDir);
        await fs.writeFile(archivePath, zipRecords([{ name: "good", body: "safe" }, ...records]));
        await expect(readArchiveEntry(archivePath, "good", { maxBytes: 4 }))
          .rejects.toMatchObject({ code: "entry-path" });
        const entryFilter = vi.fn(() => "skip" as const);
        for (const stripComponents of [0, 99]) {
          await expect(extractArchive({ archivePath, destDir, timeoutMs: 15_000,
            entryFilter, onFiltered: "skip-entry", stripComponents }))
            .rejects.toMatchObject({ code: "entry-path" });
        }
        expect(entryFilter).not.toHaveBeenCalled();
        expect(await fs.readdir(destDir)).toEqual([]);
      });
    });
  }
});
