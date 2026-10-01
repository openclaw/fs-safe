import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import * as admission from "../src/archive-zip-admission.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { unicodePath, zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

async function fixture(bytes: Buffer, prefix = "fs-safe-zip-portable-metadata-") {
  const root = await tempRoot(prefix);
  const archivePath = path.join(root, "fixture.zip"); const destDir = path.join(root, "out");
  await fs.mkdir(destDir); await fs.writeFile(archivePath, bytes);
  return { archivePath, destDir, timeoutMs: 10_000 };
}

function inspectLoadedArchive(inspect: (archive: JSZip) => void) {
  const load = JSZip.prototype.loadAsync;
  vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
    const archive = await load.apply(this, args);
    inspect(archive);
    return archive;
  });
}

describe("ZIP metadata", () => {
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

      it.each(["directory", "7"])("preserves callback order when adding a directory suffix to %s", async name => {
        configure();
        const bytes = zipRecords([
          { name: "before", body: "first" },
          { name, attributes: 0x41ed0000, body: "" },
          { name: "after", body: "last" },
        ]);
        const zip = await loadZipArchiveWithPreflight(bytes) as JSZip;
        expect(Object.keys(zip.files)).toEqual(["before", `${name}/`, "after"]);
        const input = await fixture(bytes);
        const paths: string[] = [];
        await extractArchive({ ...input, entryFilter(entry) {
          paths.push(entry.path);
          return "extract";
        } });
        expect(paths).toEqual(["before", name, "after"]);
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

  it("rejects a decoder entry replaced after admission before reading its payload", async () => {
    configureFsSafeNative({ mode: "off" });
    const input = await fixture(zipRecords([{ name: "value", body: "payload" }]));
    let replacements = 0;
    const decoded: string[] = [];
    inspectLoadedArchive(archive => {
      let files = archive.files;
      const original = files.value!;
      const replacement = Object.assign(Object.create(Object.getPrototypeOf(original)), original) as typeof original;
      replacement.nodeStream = (...params) => { decoded.push("stream"); return original.nodeStream(...params); };
      replacement.async = (...params) => { decoded.push("buffer"); return original.async(...params); };
      Object.defineProperty(archive, "files", {
        configurable: true,
        get: () => files,
        set(value: typeof files) {
          replacements += 1;
          files = { ...value, value: replacement };
        },
      });
      expect(replacement).not.toBe(original);
    });
    await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 7 })).rejects.toMatchObject({
      name: "ArchiveFormatError", code: "archive-header-invalid",
      message: "ZIP decoder disagrees with admitted directory metadata",
    });
    expect(replacements).toBe(1);
    expect(decoded).toEqual([]);
  });

  it("keeps admitted mode metadata separate from filter-time decoder mutations", async () => {
    configureFsSafeNative({ mode: "off" });
    const input = await fixture(zipRecords([{ name: "value", creatorSystem: 0, attributes: 0, body: "payload" }]));
    let captured: JSZip.JSZipObject | undefined;
    inspectLoadedArchive(archive => {
      captured = archive.files.value;
    });
    await extractArchive({ ...input, entryModes: "preserve", entryFilter(entry) {
      expect(entry).toEqual({ path: "value", kind: "file", size: 7 });
      entry.path = "changed"; entry.kind = "symlink"; entry.size = 0;
      captured!.dir = true;
      captured!.unixPermissions = 0o400;
      return "extract";
    } });
    expect(await fs.readdir(input.destDir)).toEqual(["value"]);
    const directory = await fs.stat(path.join(input.destDir, "value"));
    expect(directory.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(directory.mode & 0o777).toBe(0o755);
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
            if (field === "method") {
              mutable[1].compression = { ...(mutable[1].compression as object), magic: "bad" };
            }
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
});

describe("ZIP admission ownership", () => {
  beforeEach(() => configureFsSafeNative({ mode: "off" }));

  function ownedFixture(value = "original", sibling = "neighbor") {
    return fixture(zipRecords([
      { name: "value", body: value },
      { name: "sibling", body: sibling },
    ]), "fs-safe-zip-admission-owner-");
  }

  // Instrumented in-process decoder access, not an archive-bytes-only attack.
  function replacePublishedFiles(replace: (files: JSZip["files"]) => JSZip["files"]) {
    let substitutions = 0;
    inspectLoadedArchive(archive => {
      let files = archive.files;
      Object.defineProperty(archive, "files", {
        configurable: true,
        get: () => files,
        set(value: typeof files) { substitutions += 1; files = replace(value); },
      });
    });
    return () => expect(substitutions).toBe(1);
  }

  for (const source of ["foreign-archive", "same-archive-key", "same-archive-name"] as const) {
    for (const buffered of [false, true]) {
      it(`rejects a registered entry associated with another archive or name (${source}, buffered=${buffered})`, async () => {
        const foreign = await loadZipArchiveWithPreflight(zipRecords([{ name: "value", body: "foreign!" }])) as JSZip;
        expect(await foreign.files.value!.async("string")).toBe("foreign!");
        const input = await ownedFixture();
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
    const input = await ownedFixture();
    const assertSubstitution = replacePublishedFiles(files => ({ ...files, value: foreign.files.value! }));
    await extractArchive(input);
    assertSubstitution();
    expect(await fs.readFile(path.join(input.destDir, "value"), "utf8")).toBe("original");
    expect(await fs.readFile(path.join(input.destDir, "sibling"), "utf8")).toBe("neighbor");
  });

  it.each(["../value", "prefix/../value", "/value", "value\0suffix"])(
    "validates the selected decoder name before accepting a canonical alias: %j", async name => {
      const input = await ownedFixture();
      const assertSubstitution = replacePublishedFiles(files => { files.value!.name = name; return files; });
      await expect(readArchiveEntry(input.archivePath, "value", { maxBytes: 64 }))
        .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
      assertSubstitution();
    },
  );

  it("preserves missing, directory, link, and unsupported entry errors", async () => {
    const input = await ownedFixture();
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
    const input = await ownedFixture();
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
      const input = await ownedFixture(value, sibling);
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
});

describe("ZIP admission reuse", () => {
  it("uses one complete raw admission for a JS member read and still verifies its CRC", async () => {
    configureFsSafeNative({ mode: "off" });
    const bytes = zipRecords([{ name: "first", body: "not selected" }, { name: "value", body: "payload" }]);
    const { archivePath } = await fixture(bytes, "fs-safe-zip-admission-");
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
    const { archivePath } = await fixture(zipRecords([{ name: "value" }, { name: "../escape" }]), "fs-safe-zip-error-order-");
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
    const { archivePath } = await fixture(zipRecords([{ name: "value" }]), "fs-safe-zip-decoded-name-");
    inspectLoadedArchive(archive => {
      archive.files["../escape"] = archive.files.value!;
      delete archive.files.value;
    });
    await expect(readArchiveEntry(archivePath, "value", { maxBytes: 3 })).rejects.toMatchObject({ code: "entry-path" });
  });

  it("rejects portable decoder kind changes before returning a selected member", async () => {
    configureFsSafeNative({ mode: "off" });
    const bytes = zipRecords([{ name: "selected" }, { name: "unrelated" }]);
    const { archivePath } = await fixture(bytes, "fs-safe-zip-decoded-kind-");
    inspectLoadedArchive(archive => {
      archive.files.unrelated!.dir = true;
    });
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
});

describe("ZIP admission timing", () => {
  beforeEach(() => configureFsSafeNative({ mode: "off" }));

  it("reports synchronous public preflight validation failure through its returned promise", async () => {
    const failure = new Error("preflight limit getter failed");
    let operation: ReturnType<typeof loadZipArchiveWithPreflight> | undefined;
    expect(() => {
      operation = loadZipArchiveWithPreflight(zipRecords([]), {
        get maxArchiveBytes() { throw failure; },
      });
    }).not.toThrow();
    await expect(operation).rejects.toBe(failure);
  });

  it.each([false, true])("preserves ZIP preflight failure versus elapsed deadline precedence (expired=%s)", async expired => {
    const { archivePath, destDir } = await fixture(zipRecords([{ name: "value" }]), "fs-safe-zip-admission-timing-");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const failure = new Error("synchronous ZIP admission failed");
    const scan = vi.spyOn(admission, "admitZipBuffer").mockImplementation(() => {
      if (expired) now = 60_000;
      throw failure;
    });
    const operation = extractArchive({ archivePath, destDir, timeoutMs: 60_000 });
    if (expired) await expect(operation).rejects.toThrow("extract zip timed out after 60000ms");
    else await expect(operation).rejects.toBe(failure);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(destDir)).toEqual([]);
  });
});
