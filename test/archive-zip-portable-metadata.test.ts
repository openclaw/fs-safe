import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

async function fixture(bytes: Buffer) {
  const root = await tempRoot("fs-safe-zip-portable-metadata-");
  const archivePath = path.join(root, "fixture.zip"); const destDir = path.join(root, "out");
  await fs.mkdir(destDir); await fs.writeFile(archivePath, bytes);
  return { archivePath, destDir, timeoutMs: 10_000 };
}

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`ZIP admitted metadata ${mode}`, () => {
    function configure() {
      configureFsSafeNative({ mode });
      if (paxNative) __setNativeLoaderForTest(() => paxNative!);
    }

    it.each([0o060640, 0o140640])("retains payload bytes for UNIX type %i that JSZip calls a directory", async attributes => {
      configure();
      const input = await fixture(zipRecords([{ name: "value", attributes: (attributes << 16) >>> 0, body: "retained payload", deflate: true }]));
      const filter = vi.fn(() => "extract" as const);
      await extractArchive({ ...input, entryModes: "preserve", entryFilter: filter });
      expect(filter).toHaveBeenCalledWith({ path: "value", kind: "file", size: 16 });
      expect(await fs.readFile(path.join(input.destDir, "value"), "utf8")).toBe("retained payload");
      expect(await readArchiveEntry(input.archivePath, "value", { maxBytes: 16 })).toEqual(Buffer.from("retained payload"));
      if (process.platform !== "win32") expect((await fs.stat(path.join(input.destDir, "value"))).mode & 0o777).toBe(0o640);
    });

    it("retains directory filter size without treating its body as a file", async () => {
      configure();
      const input = await fixture(zipRecords([{ name: "directory", creatorSystem: 0, attributes: 0x41ed0000, body: "metadata" }]));
      const filter = vi.fn(() => "extract" as const);
      await extractArchive({ ...input, entryFilter: filter, limits: { maxEntryBytes: 0, maxExtractedBytes: 0 } });
      expect(filter).toHaveBeenCalledWith({ path: "directory", kind: "directory", size: 8 });
      expect((await fs.stat(path.join(input.destDir, "directory"))).isDirectory()).toBe(true);
      await expect(readArchiveEntry(input.archivePath, "directory", { maxBytes: 16 })).rejects.toThrow();
    });

    it.each([false, true])("rejects corrupt declared-zero payloads (deflate=%s)", async deflate => {
      configure();
      const bytes = zipRecords([{ name: "value", body: "payload", deflate }]);
      const central = bytes.readUInt32LE(bytes.length - 6);
      bytes.writeUInt32LE(0, 22); bytes.writeUInt32LE(0, central + 24);
      const input = await fixture(bytes);
      await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 64 })).rejects.toThrow();
      await expect(extractArchive(input)).rejects.toThrow();
      expect(await fs.readdir(input.destDir)).toEqual([]);
    });

    it("checks CRC for a zero-byte member instead of erasing its metadata", async () => {
      configure();
      const bytes = zipRecords([{ name: "value", body: "" }]);
      const central = bytes.readUInt32LE(bytes.length - 6);
      bytes.writeUInt32LE(1, 14); bytes.writeUInt32LE(1, central + 16);
      const input = await fixture(bytes);
      await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 0 })).rejects.toThrow();
      await expect(extractArchive(input)).rejects.toThrow();
      expect(await fs.readdir(input.destDir)).toEqual([]);
    });

    it("presents unsupported link-like UNIX types to policy without publishing them", async () => {
      configure();
      const input = await fixture(zipRecords([{ name: "unsupported", attributes: 0xe1ff0000 }]));
      const filter = vi.fn(() => "extract" as const);
      await extractArchive({ ...input, entryFilter: filter });
      expect(filter).toHaveBeenCalledWith({ path: "unsupported", kind: "other", size: 7 });
      expect(await fs.readdir(input.destDir)).toEqual([]);
      await expect(readArchiveEntry(input.archivePath, "unsupported", { maxBytes: 7 })).rejects.toThrow();
    });
  });
}

it("keeps simultaneous ZIP loaders isolated and restores ordinary JSZip methods", async () => {
  const file = JSZip.prototype.file;
  const results = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const data = `payload-${index}`;
    const bytes = zipRecords([
      { name: "directory", attributes: 0x41ed0000, body: "" },
      { name: "value", attributes: 0xc1a40000, body: data, deflate: index % 2 === 0 },
      { name: "link", creatorSystem: 0, attributes: 0xa1ff0010, body: "value" },
    ]);
    const archive = await loadZipArchiveWithPreflight(bytes) as JSZip;
    expect(Object.hasOwn(archive, "file")).toBe(false);
    expect(archive.file).toBe(file);
    expect(archive.files["directory/"]!.dir).toBe(true);
    expect(Number(archive.files.link!.unixPermissions) & 0o170000).toBe(0o120000);
    expect(await archive.files.value!.async("string")).toBe(data);
    archive.file("later", "ordinary JSZip mutation");
    expect(await archive.file("later")!.async("string")).toBe("ordinary JSZip mutation");
    return data;
  }));
  expect(new Set(results).size).toBe(12);
  expect(JSZip.prototype.file).toBe(file);
});

it.each(["dir", "unixPermissions", "dosPermissions", "crc32", "uncompressedSize", "compressedSize", "method"])(
  "rejects changed %s before neutralizing decoder metadata and restores its method", async field => {
    const load = JSZip.prototype.loadAsync;
    const file = JSZip.prototype.file;
    let captured: JSZip | undefined;
    vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
      captured = this;
      const insert = this.file;
      this.file = function(this: JSZip, ...values: Parameters<JSZip["file"]>) {
        const mutable = values as unknown as [string, Record<string, unknown>, Record<string, unknown>];
        if (mutable.length === 3) {
          if (field === "method") (mutable[1].compression as { magic: string }).magic = "bad";
          else if (field === "dir") mutable[2].dir = true;
          else if (field.endsWith("Permissions")) mutable[2][field] = 1;
          else mutable[1][field] = Number(mutable[1][field]) + 1;
        }
        return insert.apply(this, values);
      } as JSZip["file"];
      return await load.apply(this, args);
    });
    await expect(loadZipArchiveWithPreflight(zipRecords([{ name: "value" }])))
      .rejects.toMatchObject({ code: "archive-header-invalid" });
    expect(captured).toBeDefined();
    expect(Object.hasOwn(captured!, "file")).toBe(false);
    expect(captured!.file).toBe(file);
    expect(JSZip.prototype.file).toBe(file);
  },
);
