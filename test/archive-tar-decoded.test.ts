import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { resolveExtractLimits, resolveTarMeterLimits } from "../src/archive-limits.js";
import { TarMetadataMeter } from "../src/archive-tar-meta.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxHeader } from "./helpers/archive-pax.js";

const decodedError = { name: "ArchiveLimitError", code: "archive-decoded-size-exceeds-limit" };

async function admit(bytes: Buffer, maxDecodedBytes: number, chunkSize = 511): Promise<Buffer> {
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  }
  const output: Buffer[] = [];
  await pipeline(Readable.from(chunks()), new TarMetadataMeter({ ...resolveTarMeterLimits(), maxDecodedBytes }), new Writable({
    write(chunk: Buffer, _encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}

describe("absolute decoded TAR admission", () => {
  it.each([
    [0, 0, 0], [1.9, 1, 1],
    [0xffff_ffff, 0xffff_ffff, 0xffff_ffff],
    [0x1_0000_0000, 0x1_0000_0000, 0xffff_ffff],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0xffff_ffff],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, 0xffff_ffff],
    [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 0xffff_ffff],
  ])("clamps every internal TAR limit for finite value=%s", (value, bytes, entries) => {
    const options = { maxEntries: value, maxEntryBytes: value, maxExtractedBytes: value, maxMetaEntryBytes: value, maxArchiveBytes: 0 };
    expect(resolveTarMeterLimits(options)).toEqual({
      maxEntries: entries,
      maxMetaEntryBytes: bytes, maxDecodedBytes: bytes,
      maxManifestBytes: value === 0 ? 0 : value < 2 ? 576 : 64 * 1024 * 1024,
    });
    // Payload limits remain exclusively in the accepted-entry policy.
    expect(resolveExtractLimits(options).maxEntryBytes).toBe(Math.floor(value));
    expect(resolveExtractLimits(options).maxExtractedBytes).toBe(Math.floor(value));
  });

  it.each([NaN, Infinity, -Infinity, -1, -0.5])("retains public defaulting for malformed value=%s", (value) => {
    expect(resolveTarMeterLimits({ maxEntries: value, maxEntryBytes: value, maxExtractedBytes: value, maxMetaEntryBytes: value, maxArchiveBytes: value }))
      .toEqual(resolveTarMeterLimits());
  });

  it.each([
    [{}, 768 * 1024 * 1024],
    [{ maxArchiveBytes: 0, maxExtractedBytes: 0 }, 0],
    [{ maxArchiveBytes: 1024, maxExtractedBytes: 7 }, 1031],
    [{ maxArchiveBytes: Number.MAX_SAFE_INTEGER - 7, maxExtractedBytes: 7 }, Number.MAX_SAFE_INTEGER],
    [{ maxArchiveBytes: Number.MAX_SAFE_INTEGER - 7, maxExtractedBytes: 8 }, Number.MAX_SAFE_INTEGER],
    [{ maxArchiveBytes: Number.MAX_VALUE, maxExtractedBytes: Number.MAX_VALUE }, Number.MAX_SAFE_INTEGER],
  ] as const)("derives a safely clamped ceiling from %j", (limits, expected) => {
    expect(resolveTarMeterLimits(limits).maxDecodedBytes).toBe(expected);
  });

  it.each([
    ["EOF zero padding", Buffer.alloc(512)],
    ["GNU metadata", tarFixture([{ path: "LongName", type: "L", body: "name\0" }, { path: "empty" }], false)],
    ["PAX metadata", tarFixture([paxHeader([["size", "0"]]), { path: "empty" }], false)],
  ] as const)("stops an unbounded %s tail at the ceiling plus one probe", async (_label, pattern) => {
    const ceiling = pattern.length * 4;
    const meter = new TarMetadataMeter({ ...resolveTarMeterLimits(), maxDecodedBytes: ceiling });
    const error = new Promise<Error>((resolve) => meter.once("error", resolve));
    let forwarded = 0;
    meter.on("data", (chunk: Buffer) => { forwarded += chunk.length; });
    let supplied = 0;
    while (true) {
      if (supplied > ceiling) throw new Error("producer consumed forbidden tail");
      const length = Math.min(512, ceiling + 1 - supplied);
      const offset = supplied % pattern.length;
      const chunk = pattern.subarray(offset, offset + length);
      supplied += chunk.length;
      const failure = await new Promise<Error | null | undefined>((resolve) => meter.write(chunk, resolve));
      if (failure) break;
    }
    expect(await error).toMatchObject(decodedError);
    expect(supplied).toBe(ceiling + 1);
    expect(forwarded).toBe(ceiling);
  });

  const bytes = Buffer.concat([
    tarFixture([paxHeader([["path", "value"]]), { path: "raw", body: "payload" }, { path: "LongName", type: "L", body: "name\0" }, { path: "file" }]),
    Buffer.alloc(513),
  ]);
  it.each([0, 1, 511, 512, 513, 1023, 1024, 1536, bytes.length - 1])("charges headers, metadata, bodies, padding and EOF at ceiling=%i", async (ceiling) => {
    await expect(admit(bytes, ceiling)).rejects.toMatchObject(decodedError);
  });
  it("accepts a complete stream exactly at the ceiling", async () => {
    expect(await admit(bytes, bytes.length)).toEqual(bytes);
  });
  it.each([1, 512, 8192])("retains nonzero EOF framing errors with chunks=%i", async (chunkSize) => {
    const valid = tarFixture([{ path: "value" }]);
    await expect(admit(Buffer.concat([valid, Buffer.from([1])]), valid.length, chunkSize))
      .rejects.toMatchObject({ name: "ArchiveFormatError", code: "archive-header-invalid" });
  });
});
