import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { TarParserStream, type AdmittedTarMember } from "../src/archive-tar-wasm.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { unicodeNames, unifiedFixture, rawUnicodeFixture } from "./helpers/archive-unified.js";
import { paxHeader } from "./helpers/archive-pax.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

async function parse(bytes: Buffer, chunkSize: number) {
  const members: AdmittedTarMember[] = [];
  function* chunks() { for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize); }
  await pipeline(Readable.from(chunks()), new TarParserStream(resolveTarMeterLimits(), (entry) => members.push(entry)),
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  return members;
}

it.each([511, 512, 513])("preserves strict Unicode at metadata offset %i under arbitrary WASM chunks", async (alignment) => {
  const { bytes, payload } = unifiedFixture("雪.txt", 1, 700, alignment);
  expect(bytes.indexOf(Buffer.from("雪"))).toBe(512 + alignment);
  for (const chunk of [1, 2, 3, 7, 511, 512, 513, 1023, 65536]) {
    const entries = await parse(bytes, chunk);
    expect(entries.map(({ path, type, size }) => ({ path, type, size }))).toEqual([
      { path: "雪.txt", type: "File", size: 700 }, { path: "sentinel", type: "File", size: 3 },
    ]);
    expect(hash(bytes.subarray(entries[0]!.offset, entries[0]!.offset + entries[0]!.size))).toBe(hash(payload));
    expect(bytes.subarray(entries[1]!.offset, entries[1]!.offset + 3).toString()).toBe("end");
  }
});

let bzip = false;
try { execFileSync("bzip2", ["--help"], { stdio: "ignore" }); bzip = true; } catch { /* Not installed on every host. */ }
const routes = [
  { mode: "off", codec: "tar" }, { mode: "off", codec: "gzip" },
  ...(paxNative ? [{ mode: "require", codec: "tar" }, { mode: "require", codec: "gzip" },
    ...(typeof zlib.zstdCompressSync === "function" ? [{ mode: "require", codec: "zstd" }] : []),
    ...(bzip ? [{ mode: "require", codec: "bzip2" }] : [])] : []),
] as const;

describe.each(routes)("unified public TAR $mode/$codec", ({ mode, codec }) => {
  async function setup(bytes: Buffer) {
    configureFsSafeNative({ mode: mode as "off" | "require" });
    if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    const base = await tempRoot("fs-safe-unified-");
    const archivePath = path.join(base, "input.tar");
    const destDir = path.join(base, "out");
    await fs.mkdir(destDir);
    const encoded = codec === "gzip" ? zlib.gzipSync(bytes) : codec === "zstd" ? zlib.zstdCompressSync(bytes)
      : codec === "bzip2" ? execFileSync("bzip2", ["-c"], { input: bytes }) : bytes;
    await fs.writeFile(archivePath, encoded);
    const kind = codec === "zstd" ? "tar-zstd" as const : codec === "bzip2" ? "tar-bzip2" as const : "tar" as const;
    return { archivePath, destDir, kind, timeoutMs: 10000 };
  }
  it.each(unicodeNames)("retains exact PAX name %j, payload hash and sentinel", async (name) => {
    const { bytes, payload } = unifiedFixture(name);
    const fixture = await setup(bytes);
    const entries = await parse(bytes, 7);
    if (mode === "require") {
      const native = await paxNative!.inspectArchiveNative(fixture.archivePath, fixture.kind, resolveTarMeterLimits(), new AbortController().signal);
      expect(native.map(({ path, size, mode }) => ({ path, size, mode })))
        .toEqual(entries.map(({ path, size, mode }) => ({ path, size, mode })));
    }
    expect(hash(await readArchiveEntry(fixture.archivePath, name, { maxBytes: payload.length, kind: fixture.kind }))).toBe(hash(payload));
    await expect(readArchiveEntry(fixture.archivePath, name, { maxBytes: payload.length - 1, kind: fixture.kind }))
      .rejects.toMatchObject({ code: "archive-entry-extracted-size-exceeds-limit" });
    // TAR interpretation accepts LF on Windows; its filesystem cannot create that name.
    if (process.platform !== "win32" || !name.includes("\n")) {
      await extractArchive(fixture);
      expect((await fs.readdir(fixture.destDir)).sort()).toEqual([name, "sentinel"].sort());
      expect(hash(await fs.readFile(path.join(fixture.destDir, name)))).toBe(hash(payload));
    }
    expect((await readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 3, kind: fixture.kind })).toString()).toBe("end");
  });
  it.each([[1, 700], [700, 1], [700, 0]])("keeps newline xattrs inert before/after effective size %i -> %i", async (raw, size) => {
    for (const first of [false, true]) {
      const { bytes, payload } = unifiedFixture("雪.txt", raw, size, 511, first);
      const fixture = await setup(bytes);
      await extractArchive(fixture);
      expect(await fs.readFile(path.join(fixture.destDir, "雪.txt"))).toEqual(payload);
      expect((await readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 3, kind: fixture.kind })).toString()).toBe("end");
    }
  });
  it.each(["café", "雪.txt", "raw\nname"])("accepts PAX-attached raw UTF-8 %j", async (name) => {
    const fixture = await setup(rawUnicodeFixture(name));
    expect((await readArchiveEntry(fixture.archivePath, name, { maxBytes: 11, kind: fixture.kind })).toString()).toBe("raw payload");
    if (process.platform !== "win32" || !name.includes("\n")) {
      await extractArchive(fixture);
      expect(await fs.readFile(path.join(fixture.destDir, name), "utf8")).toBe("raw payload");
    }
  });
  it("admits strict Unicode/newline linkpath without authorizing link creation", async () => {
    const bytes = tarFixture([paxHeader([["linkpath", "雪\ntarget"]]), { path: "link", type: "2", linkPath: "raw-target" },
      { path: "sentinel", body: "end" }]);
    const fixture = await setup(bytes);
    await expect(extractArchive(fixture)).rejects.toMatchObject({ code: "entry-link" });
    expect(await fs.readdir(fixture.destDir)).toEqual([]);
    await extractArchive({ ...fixture, onFiltered: "skip-entry", entryFilter: ({ kind }) => kind === "symlink" ? "skip" : "extract" });
    expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
  });
  it.each([0, 345, 157])("rejects invalid raw UTF-8 at field %i despite a valid PAX override", async (offset) => {
    const bytes = tarFixture([paxHeader([["path", "valid"]]), { path: "raw", mutateHeader(header) { header[offset] = 0xff; } }]);
    const fixture = await setup(bytes);
    await expect(extractArchive(fixture)).rejects.toMatchObject({ code: "entry-path" });
    expect(await fs.readdir(fixture.destDir)).toEqual([]);
    await expect(readArchiveEntry(fixture.archivePath, "valid", { maxBytes: 10, kind: fixture.kind })).rejects.toMatchObject({ code: "entry-path" });
  });
  it.each([Buffer.from([0xff]), Buffer.from("before\0after")])("rejects malformed structural PAX bytes %#", async (value) => {
    const fixture = await setup(tarFixture([paxHeader([["path", value]]), { path: "raw" }]));
    await expect(extractArchive(fixture)).rejects.toMatchObject({ code: "archive-header-invalid" });
    expect(await fs.readdir(fixture.destDir)).toEqual([]);
  });
});
