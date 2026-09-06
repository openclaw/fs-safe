import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TarParserStream } from "../src/archive-tar-wasm.js";
import { resolveTarMeterLimits, type TarMeterLimits } from "../src/archive-limits.js";
import { createTarEntryPreflightChecker, type TarEntryInfo } from "../src/archive-tar.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { ignored, ignoredTypes, unsafeIgnoredPaths } from "./helpers/archive-ignored.js";

const visible = [0, ...Buffer.from("01234567D")];
const metadata = [...Buffer.from("g x K L N X".replaceAll(" ", ""))];
const ignoredFlags = Array.from({ length: 256 }, (_, i) => i).filter((byte) => !visible.includes(byte) && !metadata.includes(byte));

it("rejects raw linkname/type contradictions for all 256 flags before metadata or member emission", async () => {
  for (let type = 0; type < 256; type++) {
    const isLink = type === 0x31 || type === 0x32;
    const header = tarFixture([{
      path: "raw", linkPath: isLink ? "" : "target",
      mutateHeader(header) { header[156] = type; },
    }], false);
    const entries: TarEntryInfo[] = [];
    const meter = new TarParserStream(resolveTarMeterLimits({ maxEntries: 0, maxMetaEntryBytes: 0 }), (entry) => entries.push({ path: entry.path, type: entry.type, size: entry.size }));
    await expect(pipeline(Readable.from([header]), meter, new Writable({ write(_chunk, _encoding, callback) { callback(); } })))
      .rejects.toMatchObject({ name: "ArchiveFormatError", code: "archive-header-invalid",
        message: `invalid TAR header: linkname ${isLink ? "required on a link" : "forbidden on a non-link"} header` });
    expect(entries).toEqual([]);
  }
});

async function admit(bytes: Buffer, chunkSize: number, maxEntries = 50_000) {
  const entries: TarEntryInfo[] = [];
  const chunks = function* () {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  };
  const output: Buffer[] = [];
  await pipeline(Readable.from(chunks()), new TarParserStream(resolveTarMeterLimits({ maxEntries }), (entry) => entries.push({ path: entry.path, type: entry.type, size: entry.size })),
    new Writable({ write(chunk, _encoding, callback) { output.push(chunk); callback(); } }));
  expect(Buffer.concat(output)).toEqual(bytes);
  return entries;
}

async function rejectsBeforeEmission(bytes: Buffer, code: string, limits: Partial<TarMeterLimits> = {}, expected: TarEntryInfo[] = []) {
  const entries: TarEntryInfo[] = [];
  const meter = new TarParserStream({ ...resolveTarMeterLimits(), ...limits }, (entry) => entries.push({ path: entry.path, type: entry.type, size: entry.size }));
  await expect(pipeline(Readable.from([bytes]), meter, new Writable({ write(_chunk, _encoding, callback) { callback(); } })))
    .rejects.toMatchObject({ code });
  expect(entries).toEqual(expected);
}

// Exhaustive bytes stay in memory: 239 admitted hidden types plus fail-closed
// sparse S. Linkname semantics separately cover all 256 raw flags above.
it.each(ignoredFlags)("validates checksum, fixed fields, paths and manifest admission for hidden byte %i", async (byte) => {
  const type = String.fromCharCode(byte);
  const member = ignored(type, "./pkg//caf\u00e9");
  const raw = tarFixture([member], false);
  const corrupt = Buffer.from(raw.subarray(0, 512));
  corrupt[0] ^= 1;
  await rejectsBeforeEmission(corrupt, "archive-header-invalid", { maxEntries: 0, maxManifestBytes: 0 });
  for (const offset of [0, 345, 157]) {
    for (const value of [Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82]), Buffer.from("safe\0hidden")]) {
      const invalid = tarFixture([{ ...member, mutateHeader(header) {
        header[156] = byte;
        header.fill(0, offset, offset + 100);
        value.copy(header, offset);
      } }], false);
      await rejectsBeforeEmission(invalid, "entry-path");
    }
  }
  if (type === "S") {
    // Sparse metadata must fail before logical count or manifest emission.
    await rejectsBeforeEmission(raw, "archive-header-invalid", { maxEntries: 0, maxManifestBytes: 0 });
    return;
  }
  for (const name of unsafeIgnoredPaths) {
    for (const replacement of [[], [{ path: "LongName", type: "L", body: "safe\0" }]]) {
      await rejectsBeforeEmission(tarFixture([...replacement, ignored(type, name)]), "entry-path");
    }
  }
  const entry = { path: member.path, type: "Unsupported", size: 7 };
  expect(await admit(tarFixture([member, { path: "file" }]), 512, 2)).toEqual([
    entry, { path: "file", type: "File", size: 0 },
  ]);
  await rejectsBeforeEmission(raw.subarray(0, 512), "archive-entry-count-exceeds-limit", { maxEntries: 0 });
  await rejectsBeforeEmission(Buffer.concat([raw, raw.subarray(0, 512)]), "archive-entry-count-exceeds-limit", { maxEntries: 1 }, [entry]);
  const cost = 64 + 2 * Buffer.byteLength(member.path);
  expect(tarManifestEntryCost(member.path)).toBe(cost);
  await rejectsBeforeEmission(raw.subarray(0, 512), "archive-manifest-size-exceeds-limit", { maxManifestBytes: cost - 1 });
  await rejectsBeforeEmission(Buffer.concat([raw, raw.subarray(0, 512)]), "archive-manifest-size-exceeds-limit", { maxManifestBytes: cost }, [entry]);
});

describe.each([1, 7, 511, 512, 513, 64 * 1024])("ignored raw admission chunk=%i", (chunkSize) => {
  it("preserves node-tar's star timestamps outside the 130-byte prefix", async () => {
    const entries = await admit(tarFixture([{ path: "safe", mutateHeader(header) {
      header[156] = 0x56;
      header.write("pkg", 345);
      header.write("00000000001\0", 476, "ascii");
      header.write("00000000002\0", 488, "ascii");
    } }]), chunkSize);
    expect(entries).toEqual([{ path: "pkg/safe", type: "Unsupported", size: 0 }]);
  });
  it("reports every logical member in order and consumes GNU names once", async () => {
    const entries = await admit(tarFixture([
      ignored("V", "./pkg//first"), { path: "pkg/visible", body: "file" },
      { path: "LongName", type: "L", body: "pkg/effective\0" }, ignored("A"), ignored("?", "pkg/last"),
    ]), chunkSize);
    expect(entries).toEqual([
      { path: "./pkg//first", type: "Unsupported", size: 7 }, { path: "pkg/visible", type: "File", size: 4 },
      { path: "pkg/effective", type: "Unsupported", size: 7 }, { path: "pkg/last", type: "Unsupported", size: 7 },
    ]);
  });
  it.each(ignoredTypes)("counts ignored %s headers before requesting their bodies", async (type) => {
    const meter = new TarParserStream(resolveTarMeterLimits({ maxEntries: 1 }));
    meter.resume();
    const failure = new Promise<Error>((resolve) => meter.once("error", resolve));
    const prefix = Buffer.concat([tarFixture([ignored(type)], false), tarFixture([ignored(type, "second")]).subarray(0, 512)]);
    await new Promise<void>((resolve) => meter.write(prefix, () => resolve()));
    expect(await failure).toMatchObject({ code: "archive-entry-count-exceeds-limit" });
  });
});

it("keeps unsupported raw flags under the same alias/collision policy for arbitrary ordering and chunking", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...ignoredFlags.filter((byte) => byte !== 0x53)),
    fc.integer({ min: 1, max: 2048 }), fc.boolean(),
    fc.constantFrom("./pkg//item", "pkg\\item", "pkg/./item"),
    async (byte, chunk, first, alias) => {
      const hidden = ignored(String.fromCharCode(byte), alias);
      const file = { path: "pkg/item", body: "value" };
      const entries = await admit(tarFixture(first ? [hidden, file] : [file, hidden]), chunk, 2);
      const calls: string[] = [];
      const check = createTarEntryPreflightChecker({ rootDir: process.cwd(), onFiltered: "skip-entry", entryFilter: ({ path }) => { calls.push(path); return "skip"; } });
      expect(() => entries.forEach(check)).toThrow(expect.objectContaining({ code: "entry-path" }));
      expect(calls).toEqual(["pkg/item"]);
    },
  ), { numRuns: 100, seed: 47 });
});

function tarManifestEntryCost(path: string): number {
  return 64 + 2 * Buffer.byteLength(path, "utf8");
}
