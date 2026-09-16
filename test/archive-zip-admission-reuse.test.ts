import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import * as admission from "../src/archive-zip-admission.js";
import { loadZipArchiveWithPreflight } from "../src/archive-zip-preflight.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest(); });

it("uses one complete raw admission for a JS member read and still verifies its CRC", async () => {
  configureFsSafeNative({ mode: "off" });
  const dir = await tempRoot("fs-safe-zip-admission-");
  const archivePath = path.join(dir, "input.zip");
  const bytes = zipRecords([{ name: "first", body: "not selected" }, { name: "value", body: "payload" }]);
  await fs.writeFile(archivePath, bytes);
  const scan = vi.spyOn(admission, "admitZipBuffer");
  expect(await readArchiveEntry(archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
  expect(scan).toHaveBeenCalledTimes(1);
  bytes[bytes.indexOf(Buffer.from("payload"))]! ^= 1;
  await fs.writeFile(archivePath, bytes);
  await expect(readArchiveEntry(archivePath, "value", { maxBytes: 7 })).rejects.toThrow("zip entry integrity check failed: value");
  expect(scan).toHaveBeenCalledTimes(2);
});

it("keeps raw validation ahead of a required-native load failure", async () => {
  configureFsSafeNative({ mode: "require" });
  __setNativeLoaderForTest(() => { throw new Error("no native binding"); });
  const dir = await tempRoot("fs-safe-zip-error-order-");
  const archivePath = path.join(dir, "input.zip");
  await fs.writeFile(archivePath, zipRecords([{ name: "value" }, { name: "../escape" }]));
  await expect(readArchiveEntry(archivePath, "value", { maxBytes: 1 })).rejects.toMatchObject({ code: "entry-path" });
});

it("re-admits public preflight inputs on every call", async () => {
  const bytes = zipRecords([{ name: "good" }]);
  expect(Object.keys((await loadZipArchiveWithPreflight(bytes)).files)).toEqual(["good"]);
  bytes.write("../x", 30);
  await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "entry-path" });
});

it("rejects decoder name changes even when its entry count matches", async () => {
  configureFsSafeNative({ mode: "off" });
  const dir = await tempRoot("fs-safe-zip-decoded-name-");
  const archivePath = path.join(dir, "input.zip");
  await fs.writeFile(archivePath, zipRecords([{ name: "value" }]));
  const altered = new JSZip(); altered.file("../escape", "bad", { createFolders: false });
  expect(Object.keys(altered.files)).toEqual(["../escape"]);
  vi.spyOn(JSZip, "loadAsync").mockResolvedValue(altered);
  await expect(readArchiveEntry(archivePath, "value", { maxBytes: 3 })).rejects.toMatchObject({ code: "entry-path" });
});

it("rejects portable decoder kind changes before returning a selected member", async () => {
  configureFsSafeNative({ mode: "off" });
  const dir = await tempRoot("fs-safe-zip-decoded-kind-");
  const archivePath = path.join(dir, "input.zip");
  const bytes = zipRecords([{ name: "selected" }, { name: "unrelated" }]);
  await fs.writeFile(archivePath, bytes);
  const altered = await JSZip.loadAsync(bytes);
  altered.files.unrelated!.dir = true;
  vi.spyOn(JSZip, "loadAsync").mockResolvedValue(altered);
  const scan = vi.spyOn(admission, "admitZipBuffer");
  await expect(readArchiveEntry(archivePath, "selected", { maxBytes: 7 })).rejects.toMatchObject({ code: "archive-header-invalid" });
  expect(scan).toHaveBeenCalledTimes(1);
  await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "archive-header-invalid" });
});

it("resets strict UTF-8 decoding after errors and preserves repeated BOM-prefixed names", async () => {
  const invalid = zipRecords([{ name: Buffer.from([0xc3]), flags: 0x800 }]);
  for (const name of ["\ufefffirst", "\ufeffsecond"]) {
    expect(() => admission.admitZipBuffer(invalid, resolveExtractLimits())).toThrow(/UTF-8/);
    const archive = await loadZipArchiveWithPreflight(zipRecords([{ name, flags: 0x800 }]));
    expect(Object.keys(archive.files)).toEqual([name]);
  }
  // A legacy high byte is not a Unicode space in the raw ASCII syntax check.
  expect(admission.admitZipBuffer(zipRecords([{ name: Buffer.from([78, 85, 76, 160]) }]), resolveExtractLimits())).toBe(1);
});
