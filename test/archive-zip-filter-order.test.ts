import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { unicodePath, zipRecords, type ZipRecord } from "./helpers/zip-records.js";

let nativeAvailable = false;
try { nativeAvailable = Boolean(__loadBundledNativeForTest()); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
const { tempRoot } = useRealTempDirs();
afterEach(() => __resetFsSafeNativeConfigForTest());

async function fixture(records: ZipRecord[]) {
  const work = await tempRoot("fs-safe-zip-order-");
  const archivePath = path.join(work, "input.zip"), destDir = path.join(work, "output");
  await fs.writeFile(archivePath, zipRecords(records));
  await fs.mkdir(destDir);
  return { archivePath, destDir, kind: "zip" as const };
}

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !nativeAvailable)(`ZIP filter physical order (${mode})`, () => {
    it.each([
      ["20", "2"],
      ["first", "20", "2", "last"],
      ["4294967295", "4294967294", "00", "0"],
    ])("selects the physical first record in %j", async (...names) => {
      configureFsSafeNative({ mode });
      const input = await fixture(names.map(name => ({ name, body: `payload:${name}` })));
      const observed: string[] = [];
      await extractArchive({ ...input, onFiltered: "skip-entry", entryFilter: entry => {
        observed.push(entry.path);
        return observed.length === 1 ? "extract" : "skip";
      } });
      expect(observed).toEqual(names);
      expect(await fs.readdir(input.destDir)).toEqual([names[0]]);
      expect(await fs.readFile(path.join(input.destDir, names[0]!), "utf8")).toBe(`payload:${names[0]}`);
    });

    it("retains numeric Unicode names in physical order", async () => {
      configureFsSafeNative({ mode });
      const input = await fixture(["20", "2"].map((name, index) => ({
        name: `legacy${index}`, extra: unicodePath(Buffer.from(`legacy${index}`), name), body: name,
      })));
      const observed: string[] = [];
      await extractArchive({ ...input, entryFilter: entry => { observed.push(entry.path); return "extract"; } });
      expect(observed).toEqual(["20", "2"]);
      expect(await fs.readFile(path.join(input.destDir, "20"), "utf8")).toBe("20");
      expect(await fs.readFile(path.join(input.destDir, "2"), "utf8")).toBe("2");
    });

    it("keeps pre-strip filter paths and independent concurrent archives", async () => {
      configureFsSafeNative({ mode });
      await Promise.all(["", "pkg/"].map(async prefix => {
        const names = [`${prefix}30`, `${prefix}3`];
        const input = await fixture(names.map(name => ({ name })));
        const observed: string[] = [];
        await extractArchive({ ...input, stripComponents: prefix ? 1 : 0, entryFilter: entry => {
          observed.push(entry.path); return "extract";
        } });
        expect(observed).toEqual(names);
        expect((await fs.readdir(input.destDir)).sort()).toEqual(["3", "30"]);
      }));
    });

    it("preserves the filter error at the first physical record", async () => {
      configureFsSafeNative({ mode });
      const input = await fixture([{ name: "20" }, { name: "2" }]);
      const failure = new Error("filter refused");
      const observed: string[] = [];
      await expect(extractArchive({ ...input, entryFilter: entry => {
        observed.push(entry.path); throw failure;
      } })).rejects.toBe(failure);
      expect(observed).toEqual(["20"]);
      expect(await fs.readdir(input.destDir)).toEqual([]);
    });
  });
}

it("preserves the public JSZip files object enumeration and mutation contract", async () => {
  const archive = await loadZipArchiveWithPreflight(zipRecords([{ name: "20" }, { name: "2" }]));
  expect(Object.keys(archive.files)).toEqual(["2", "20"]);
  const entry = archive.files["20"];
  delete archive.files["20"];
  archive.files["again"] = entry;
  expect(Object.keys(archive.files)).toEqual(["2", "again"]);
});
