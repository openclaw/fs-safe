import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { unicodePath, zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(value = "original", sibling = "neighbor") {
  const root = await tempRoot("fs-safe-zip-admission-owner-");
  const archivePath = path.join(root, "input.zip"), destDir = path.join(root, "output");
  await fs.mkdir(destDir);
  await fs.writeFile(archivePath, zipRecords([
    { name: "value", body: value },
    { name: "sibling", body: sibling },
  ]));
  return { archivePath, destDir, timeoutMs: 10_000 };
}

// Instrumented in-process decoder access, not an archive-bytes-only attack.
function replacePublishedFiles(replace: (files: JSZip["files"]) => JSZip["files"]) {
  const load = JSZip.prototype.loadAsync;
  let substitutions = 0;
  vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
    const archive = await load.apply(this, args);
    let files = archive.files;
    Object.defineProperty(archive, "files", {
      configurable: true,
      get: () => files,
      set(value: typeof files) { substitutions += 1; files = replace(value); },
    });
    return archive;
  });
  return () => expect(substitutions).toBe(1);
}

for (const source of ["foreign-archive", "same-archive-key", "same-archive-name"] as const) {
  for (const buffered of [false, true]) {
    it(`rejects a registered entry associated with another archive or name (${source}, buffered=${buffered})`, async () => {
      const foreign = await loadZipArchiveWithPreflight(zipRecords([{ name: "value", body: "foreign!" }])) as JSZip;
      expect(await foreign.files.value!.async("string")).toBe("foreign!");
      const input = await fixture();
      expect(await readArchiveEntry(input.archivePath, "value", { maxBytes: 64 })).toEqual(Buffer.from("original"));
      const decoded: string[] = [];
      const assertSubstitution = replacePublishedFiles((files) => {
        const substitute = source === "foreign-archive" ? foreign.files.value! : files.sibling!;
        const stream = substitute.nodeStream.bind(substitute), read = substitute.async.bind(substitute);
        if (buffered) Object.defineProperty(substitute, "nodeStream", { value: undefined });
        else substitute.nodeStream = (...args) => { decoded.push("stream"); return stream(...args); };
        substitute.async = (...args) => { decoded.push("buffer"); return read(...args); };
        if (source === "foreign-archive") return { ...files, value: substitute };
        files.value!.name = "sibling";
        substitute.name = "value";
        return source === "same-archive-key" ? { value: substitute, sibling: files.value! } : files;
      });
      await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 64 })).rejects.toMatchObject({
        name: "ArchiveFormatError", code: "archive-header-invalid",
        message: "ZIP decoder disagrees with admitted directory metadata",
      });
      assertSubstitution();
      expect(decoded).toEqual([]);
    });
  }
}

it("keeps extraction on its own admitted entries when the public files object receives a foreign entry", async () => {
  const foreign = await loadZipArchiveWithPreflight(zipRecords([{ name: "value", body: "foreign!" }])) as JSZip;
  const input = await fixture();
  const assertSubstitution = replacePublishedFiles(files => ({ ...files, value: foreign.files.value! }));
  await extractArchive(input);
  assertSubstitution();
  expect(await fs.readFile(path.join(input.destDir, "value"), "utf8")).toBe("original");
  expect(await fs.readFile(path.join(input.destDir, "sibling"), "utf8")).toBe("neighbor");
});

it.each(["../value", "prefix/../value", "/value", "value\0suffix"])(
  "validates the selected decoder name before accepting a canonical alias: %j", async name => {
    const input = await fixture();
    const assertSubstitution = replacePublishedFiles(files => { files.value!.name = name; return files; });
    await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 64 }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    assertSubstitution();
  },
);

it("preserves missing, directory, link, and unsupported entry errors", async () => {
  const input = await fixture();
  await fs.writeFile(input.archivePath, zipRecords([
    { name: "directory", attributes: 0x41ed0000, body: "" },
    { name: "link", attributes: 0xa1ff0000, body: "target" },
    { name: "other", attributes: 0xe1ff0000, body: "" },
  ]));
  for (const [name, message] of [
    ["absent", "archive entry not found: absent"],
    ["directory", "archive entry not found: directory"],
    ["link", "archive entry is a link: link"],
    ["other", "archive entry is not a file: other"],
  ] as const) {
    await expect(readArchiveEntry(input.archivePath, name, { maxBytes: 64 }))
      .rejects.toMatchObject({ name: "Error", message });
  }
});

it("indexes canonical aliases and Unicode names independently of numeric property order", async () => {
  const input = await fixture();
  await fs.writeFile(input.archivePath, zipRecords([
    { name: "20", body: "twenty" },
    { name: "2", body: "two" },
    { name: "./parent//value", localName: "parent\\.\\value", body: "nested" },
    { name: "legacy", extra: unicodePath(Buffer.from("legacy"), "日本語/value"), body: "unicode" },
  ]));
  for (const [name, payload] of [["20", "twenty"], ["2", "two"], ["parent\\value", "nested"], ["./日本語//value", "unicode"]] as const) {
    expect(await readArchiveEntry(input.archivePath, name, { maxBytes: 64 })).toEqual(Buffer.from(payload));
  }
});

it("keeps concurrent reads, extractions, and mutable public preflight archives independent", async () => {
  await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const value = `value-${index}`, sibling = `sibling-${index}`;
    const input = await fixture(value, sibling);
    const publicArchive = await loadZipArchiveWithPreflight(await fs.readFile(input.archivePath)) as JSZip;
    publicArchive.file("value", "public replacement");
    publicArchive.file("added", "public addition");
    const [read, other] = await Promise.all([
      readArchiveEntry(input.archivePath, "value", { maxBytes: 64 }),
      readArchiveEntry(input.archivePath, "sibling", { maxBytes: 64 }),
      extractArchive(input),
    ]);
    expect(read).toEqual(Buffer.from(value));
    expect(other).toEqual(Buffer.from(sibling));
    expect(await fs.readFile(path.join(input.destDir, "value"), "utf8")).toBe(value);
    expect(await fs.readFile(path.join(input.destDir, "sibling"), "utf8")).toBe(sibling);
    expect(await publicArchive.file("value")!.async("string")).toBe("public replacement");
    expect(await publicArchive.file("added")!.async("string")).toBe("public addition");
  }));
});
