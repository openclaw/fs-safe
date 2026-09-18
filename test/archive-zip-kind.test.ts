import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { admitZipBuffer } from "../src/archive-zip-admission.js";
import type { ZipDirectoryEntry } from "../src/archive-zip-directory.js";
import { loadZipArchiveWithPreflight } from "../src/archive-zip-preflight.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { unicodePath, zipRecords, type ZipRecord } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });
const formatError = { name: "ArchiveFormatError", code: "archive-header-invalid" };
const directories = [
  { label: "DOS bit", name: "item", attributes: 0x10 },
  { label: "DOS bit with UNIX file mode", name: "item", attributes: 0x81a40010 },
  { label: "UNIX directory type", name: "item", attributes: 0x41ed0000 },
  { label: "slash", name: "item/", attributes: 0 },
  { label: "backslash", name: "item\\", attributes: 0 },
  { label: "backslash and DOS bit", name: "item\\", attributes: 0x10 },
  { label: "slash and UNIX directory type", name: "item/", attributes: 0x41ed0000 },
];

async function fixture(entries: ZipRecord[]) {
  const dir = await tempRoot("fs-safe-zip-kind-");
  const archivePath = path.join(dir, "input.zip"); const destDir = path.join(dir, "out");
  const bytes = zipRecords(entries);
  await fs.mkdir(destDir); await fs.writeFile(archivePath, bytes);
  return { bytes, archivePath, destDir, timeoutMs: 10000 };
}

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !native)(`ZIP kind contract (${mode})`, () => {
    function configure() {
      configureFsSafeNative({ mode });
      if (native) __setNativeLoaderForTest(() => native!);
    }

    for (const creatorSystem of [0, 3, 19, 255]) {
      it.each(directories)(`classifies $label for creator ${creatorSystem}`, async ({ name, attributes }) => {
        configure();
        const input = await fixture([{ name, attributes, creatorSystem, body: "" }]);
        const entries: ZipDirectoryEntry[] = [];
        expect(admitZipBuffer(input.bytes, resolveExtractLimits(), entry => { entries.push(entry); })).toBe(1);
        expect(entries[0]?.kind).toBe("directory");
        const filter = vi.fn(() => "skip" as const);
        await expect(loadZipArchiveWithPreflight(input.bytes)).resolves.toHaveProperty("files");
        await extractArchive({ ...input, entryFilter: filter, onFiltered: "skip-entry" });
        expect(filter).toHaveBeenCalledExactlyOnceWith({ path: "item", kind: "directory", size: 0 });
        expect(await fs.readdir(input.destDir)).toEqual([]);
        await extractArchive(input);
        expect((await fs.stat(path.join(input.destDir, "item"))).isDirectory()).toBe(true);
        await expect(readArchiveEntry(input.archivePath, "item", { maxBytes: 0 })).rejects.toThrow(/not (a file|found)/);
      });

      it.each(["item", "item/", "item\\"])(`keeps high-word symlinks first for creator ${creatorSystem}: %s`, async name => {
        configure();
        const input = await fixture([{ name, creatorSystem, attributes: 0xa1ff0010, body: "target" }]);
        const filter = vi.fn(() => "skip" as const);
        await extractArchive({ ...input, entryFilter: filter, onFiltered: "skip-entry" });
        expect(filter).toHaveBeenCalledWith({ path: "item", kind: "symlink", size: 6 });
        await expect(extractArchive(input)).rejects.toMatchObject({ code: "entry-link" });
        await expect(readArchiveEntry(input.archivePath, "item", { maxBytes: 16 })).rejects.toThrow();
        expect(await fs.readdir(input.destDir)).toEqual([]);
      });
    }

    it.each([
      { name: "item", localName: "item/" },
      { name: "item/", localName: "item" },
      { name: "item\\", localName: "item" },
      { name: "item/", localName: "item/." },
      { name: "item", extra: unicodePath(Buffer.from("item"), "item/") },
      { name: "item/", extra: unicodePath(Buffer.from("item/"), "item") },
      { name: "item", localExtra: unicodePath(Buffer.from("item"), "item\\") },
      { name: "item/", extra: unicodePath(Buffer.from("item/"), "item/"), localExtra: unicodePath(Buffer.from("item/"), "item") },
    ])("rejects marker disagreement before any callback: %j", async entry => {
      configure();
      const input = await fixture([{ name: "keep" }, { ...entry, attributes: 0x10 }]);
      const filter = vi.fn(() => "skip" as const);
      await expect(loadZipArchiveWithPreflight(input.bytes)).rejects.toMatchObject(formatError);
      await expect(extractArchive({ ...input, stripComponents: 99, entryFilter: filter, onFiltered: "skip-entry" })).rejects.toMatchObject(formatError);
      await expect(readArchiveEntry(input.archivePath, "keep", { maxBytes: 7 })).rejects.toMatchObject(formatError);
      expect(filter).not.toHaveBeenCalled();
      expect(await fs.readdir(input.destDir)).toEqual([]);
    });

    it("preserves internal separator/dot aliases and matching terminal markers", async () => {
      configure();
      const input = await fixture([
        { name: "./parent//item/", localName: "parent\\.\\item\\", attributes: 0x10, body: "" },
        { name: "./parent//file", localName: "parent\\.\\file", body: "payload" },
        { name: "raw/", extra: unicodePath(Buffer.from("raw/"), "unicode/"), attributes: 0x10, body: "" },
        { name: "flagged\\", flags: 0x800, extra: unicodePath(Buffer.from("flagged\\"), "flagged/"), attributes: 0, body: "" },
        { name: "unflagged/", localName: "unflagged\\", extra: unicodePath(Buffer.from("unflagged/"), "unflagged/"), attributes: 0, body: "" },
        { name: "20", body: "twenty" }, { name: "2", body: "two" },
      ]);
      await extractArchive(input);
      expect((await fs.stat(path.join(input.destDir, "parent", "item"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(input.destDir, "unicode"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(input.destDir, "flagged"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(input.destDir, "unflagged"))).isDirectory()).toBe(true);
      expect(await readArchiveEntry(input.archivePath, "parent/file", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      expect(await readArchiveEntry(input.archivePath, "2", { maxBytes: 3 })).toEqual(Buffer.from("two"));
      await expect(readArchiveEntry(input.archivePath, "parent/file", { maxBytes: 6 })).rejects.toMatchObject({ code: "archive-entry-extracted-size-exceeds-limit" });
    });

    it("does not mistake a UNIX socket type for the exact directory type", async () => {
      configure();
      const input = await fixture([{ name: "item", creatorSystem: 3, attributes: 0xc1ed0000 }]);
      const filter = vi.fn(() => "skip" as const);
      await extractArchive({ ...input, entryFilter: filter, onFiltered: "skip-entry" });
      expect(filter).toHaveBeenCalledWith(expect.objectContaining({ kind: "file" }));
      expect(await fs.readdir(input.destDir)).toEqual([]);
    });
  });
}
