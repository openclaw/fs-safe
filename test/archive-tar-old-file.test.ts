import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { Parser } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { createTarAdmissionPlan, rawTarMember } from "../src/archive-tar-admission.js";
import { readTarEntryInfo, type TarEntryInfo } from "../src/archive-tar.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { tarFixture, type TarFixtureEntry } from "./helpers/archive-fuzz.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const payload = Buffer.from([0, 1, 2, 0xfe, 0xff]);

function oldFile(entryPath: string): TarFixtureEntry {
  // Build a file body first; the fixture helper's type list excludes NUL.
  return { path: entryPath, body: payload, mutateHeader(header) { header[156] = 0; } };
}

describe("TAR regular-file parser agreement", () => {
  it.each([0x00, 0x30])("matches node-tar's emitted type for raw byte %i", async (byte) => {
    const bytes = tarFixture([{
      path: "./pkg//legacy.bin", body: payload,
      mutateHeader(header) { header[156] = byte; },
    }]);
    const member = rawTarMember(bytes.subarray(0, 512), payload.length);
    const check = vi.fn(() => true);
    const plan = createTarAdmissionPlan([member], check, 1);
    const parsed: TarEntryInfo[] = [];
    await pipeline(Readable.from([bytes]), new Parser({
      strict: true,
      onReadEntry(entry) { parsed.push(readTarEntryInfo(entry)); entry.resume(); },
    }));

    expect(parsed).toHaveLength(1);
    expect(member.type).toBe(parsed[0]!.type);
    if (byte === 0x30) expect(member.type).toBe("File");
    expect(plan.consume(parsed[0]!)).toBe("legacy.bin");
    expect(() => plan.finish()).not.toThrow();
    expect(check.mock.calls).toEqual([[member]]);
  });

  it.each(["OldFile", "File"])("accepts a matching %s plan but rejects a different parser type", (type) => {
    const member = { path: "./pkg//legacy.bin", type, size: payload.length };
    const actual = { ...member, path: "pkg/legacy.bin" };
    const plan = createTarAdmissionPlan([member], () => true, 1);
    expect(plan.consume(actual)).toBe("legacy.bin");
    expect(() => plan.finish()).not.toThrow();

    const mismatch = createTarAdmissionPlan([member], () => true, 1);
    expect(() => mismatch.consume({ ...actual, type: "Directory" })).toThrowError(expect.objectContaining({
      name: "ArchiveFormatError", code: "archive-header-invalid",
      message: "invalid TAR header: parser disagrees with raw admission",
    }));
  });
});

// The NUL/ASCII-zero parser distinction is JS-specific; plain and gzip exercise
// both JS routes without duplicating the native regular-file integration matrix.
describe.each(["tar", "gzip"] as const)("NUL-typeflag public JS %s", (format) => {
  beforeEach(() => configureFsSafeNative({ mode: "off" }));
  afterEach(() => __resetFsSafeNativeConfigForTest());

  async function setup(entries: TarFixtureEntry[]) {
    const root = await tempRoot("fs-safe-tar-old-file-");
    const archivePath = path.join(root, format === "gzip" ? "fixture.tar.gz" : "fixture.tar");
    const destDir = path.join(root, "out");
    const bytes = tarFixture(entries);
    await fs.writeFile(archivePath, format === "gzip" ? gzipSync(bytes) : bytes);
    await fs.mkdir(destDir);
    await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
    return { archivePath, destDir };
  }

  it.each([0, 1])("extracts regular-file bytes with canonical filtering and strip=%i", async (stripComponents) => {
    const options = await setup([
      oldFile("./pkg//legacy.bin"), { path: "./pkg//modern.bin", body: "modern" },
    ]);
    const entryFilter = vi.fn(() => "extract" as const);
    await extractArchive({ ...options, stripComponents, entryFilter });

    expect(entryFilter.mock.calls).toEqual([
      [{ path: "pkg/legacy.bin", kind: "file", size: payload.length }],
      [{ path: "pkg/modern.bin", kind: "file", size: 6 }],
    ]);
    const output = stripComponents ? options.destDir : path.join(options.destDir, "pkg");
    expect(await fs.readFile(path.join(output, "legacy.bin"))).toEqual(payload);
    expect((await fs.stat(path.join(output, "legacy.bin"))).isFile()).toBe(true);
    expect(await fs.readFile(path.join(output, "modern.bin"), "utf8")).toBe("modern");
    expect((await fs.readdir(options.destDir, { recursive: true })).sort()).toEqual(
      stripComponents ? ["legacy.bin", "modern.bin", "sentinel"]
        : ["pkg", "pkg/legacy.bin", "pkg/modern.bin", "sentinel"].map((name) => name.split("/").join(path.sep)),
    );
    expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
  });

  it.each([
    { name: "canonical alias", secondPath: "./pkg/legacy.bin", stripComponents: 0 },
    { name: "stripped output", secondPath: "other/legacy.bin", stripComponents: 1 },
  ])("rejects a $name collision with an ASCII-zero file before publication", async ({ secondPath, stripComponents }) => {
    const options = await setup([oldFile("./pkg//legacy.bin"), { path: secondPath, body: "collision" }]);
    const entryFilter = vi.fn(() => "extract" as const);
    await expect(extractArchive({ ...options, stripComponents, entryFilter }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/legacy.bin", kind: "file", size: payload.length }]]);
    expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("omits a fully stripped NUL file before filtering", async () => {
    const options = await setup([oldFile("./discarded"), { path: "pkg/modern.bin", body: "modern" }]);
    const entryFilter = vi.fn(() => "extract" as const);
    await extractArchive({ ...options, stripComponents: 1, entryFilter });
    expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/modern.bin", kind: "file", size: 6 }]]);
    expect((await fs.readdir(options.destDir)).sort()).toEqual(["modern.bin", "sentinel"]);
    expect(await fs.readFile(path.join(options.destDir, "modern.bin"), "utf8")).toBe("modern");
    expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("reads the NUL file bytes through the public entry reader", async () => {
    const options = await setup([oldFile("./pkg//legacy.bin"), { path: "pkg/modern.bin", body: "modern" }]);
    await expect(readArchiveEntry(options.archivePath, "pkg/legacy.bin", { maxBytes: payload.length }))
      .resolves.toEqual(payload);
    expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
  });
});
