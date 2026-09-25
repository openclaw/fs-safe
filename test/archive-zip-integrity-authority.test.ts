import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { fixtureCrc32, zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const original = Buffer.from("payload");
const replacement = Buffer.from("altered");
type Operation = "extract" | "read";
type DecoderEntry = JSZip.JSZipObject & {
  _data: { compressedContent: Buffer; compressedSize: number; uncompressedSize: number; crc32: number };
};

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(bytes: Buffer) {
  const root = await tempRoot("fs-safe-zip-integrity-authority-");
  const archivePath = path.join(root, "fixture.zip");
  const destDir = path.join(root, "out");
  await fs.mkdir(destDir);
  await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
  await fs.writeFile(archivePath, bytes);
  return { archivePath, destDir, timeoutMs: 10_000 };
}

// This models in-process decoder access, not an archive-bytes-only attack.
// Keep the admitted entry object; replacing it is a separate association check.
function mutateAfterAdmission(operation: Operation, mutate: (entry: DecoderEntry) => void) {
  const load = JSZip.prototype.loadAsync;
  let captured: DecoderEntry;
  let mutations = 0;
  const apply = (entry: DecoderEntry) => { mutate(entry); mutations += 1; };
  vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
    const archive = await load.apply(this, args);
    captured = archive.files.value as DecoderEntry;
    if (operation === "read") {
      let files = archive.files;
      Object.defineProperty(archive, "files", {
        configurable: true,
        get: () => files,
        set(value: typeof files) {
          files = value;
          expect(files.value).toBe(captured);
          apply(captured);
        },
      });
    }
    return archive;
  });
  return {
    entryFilter() { apply(captured); return "extract" as const; },
    assertMutation() { expect(mutations).toBe(1); },
  };
}

for (const operation of ["extract", "read"] as const) {
  for (const deflate of [false, true]) {
    for (const buffered of [false, true]) {
      it(`rejects post-admission payload and CRC replacement (${operation}, deflate=${deflate}, buffered=${buffered})`, async () => {
        const input = await fixture(zipRecords([{ name: "value", body: original.toString(), deflate }]));
        const mutation = mutateAfterAdmission(operation, (entry) => {
          const compressed = deflate ? deflateRawSync(replacement) : replacement;
          entry._data.compressedContent = compressed;
          entry._data.compressedSize = compressed.length;
          entry._data.uncompressedSize = replacement.length;
          entry._data.crc32 = fixtureCrc32(replacement);
          if (buffered) Object.defineProperty(entry, "nodeStream", { value: undefined });
        });
        expect(replacement.length).toBe(original.length);
        expect(fixtureCrc32(replacement)).not.toBe(fixtureCrc32(original));
        const result = operation === "extract"
          ? extractArchive({ ...input, entryFilter: mutation.entryFilter })
            .then(() => fs.readFile(path.join(input.destDir, "value")))
          : readArchiveEntry(input.archivePath, "value", { maxBytes: 64 });
        await expect(result).rejects.toMatchObject({
          name: "ArchiveFormatError", code: "archive-header-invalid",
          message: "zip entry integrity check failed: value",
        });
        mutation.assertMutation();
        expect(await fs.readdir(input.destDir)).toEqual(["sentinel"]);
        expect(await fs.readFile(path.join(input.destDir, "sentinel"), "utf8")).toBe("unchanged");
      });
    }
  }
  it(`rejects post-admission decoder size changes that hide a physical size mismatch (${operation})`, async () => {
    const bytes = zipRecords([{ name: "value", body: original.toString() }]);
    const central = bytes.readUInt32LE(bytes.length - 6);
    bytes.writeUInt32LE(original.length + 1, 22);
    bytes.writeUInt32LE(original.length + 1, central + 24);
    const input = await fixture(bytes);
    const mutation = mutateAfterAdmission(operation, (entry) => {
      entry._data.uncompressedSize = original.length;
    });
    const result = operation === "extract"
      ? extractArchive({ ...input, entryFilter: mutation.entryFilter })
        .then(() => fs.readFile(path.join(input.destDir, "value")))
      : readArchiveEntry(input.archivePath, "value", { maxBytes: 64 });
    await expect(result).rejects.toMatchObject({
      name: "ArchiveFormatError", code: "archive-header-invalid",
      message: "zip entry integrity check failed: value",
    });
    mutation.assertMutation();
    expect(await fs.readdir(input.destDir)).toEqual(["sentinel"]);
  });
}

it("keeps public preflight entries readable and replaceable through ordinary JSZip methods", async () => {
  const archive = await loadZipArchiveWithPreflight(zipRecords([{ name: "value", body: "payload" }])) as JSZip;
  expect(await archive.file("value")!.async("string")).toBe("payload");
  archive.file("value", "caller replacement");
  archive.file("later", "caller addition");
  expect(await archive.file("value")!.async("string")).toBe("caller replacement");
  expect(await archive.file("later")!.async("string")).toBe("caller addition");
  delete archive.files.later;
  expect(Object.keys(archive.files)).toEqual(["value"]);
  expect(archive.file).toBe(JSZip.prototype.file);
  expect(Object.hasOwn(archive, "file")).toBe(false);
});
