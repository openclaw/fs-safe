import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { resolveTarMeterLimits, type ArchiveExtractLimits } from "../src/archive-limits.js";
import { TarMetadataMeter } from "../src/archive-tar-meta.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxArchive, paxHeader } from "./helpers/archive-pax.js";
import { malformedTarFraming } from "./helpers/archive-tar-framing.js";

async function meter(bytes: Buffer, chunkSize: number): Promise<Buffer> {
  const output: Buffer[] = [];
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  }
  await pipeline(Readable.from(chunks()), new TarMetadataMeter(resolveTarMeterLimits({ maxMetaEntryBytes: 1024 })), new Writable({
    write(chunk: Buffer, _encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}

describe.each([1, 7, 511, 512, 513, 1023, 4096])("raw TAR meter chunks=%i", (chunkSize) => {
  it.each(malformedTarFraming)("rejects %s", async (_label, bytes) => {
    await expect(meter(bytes, chunkSize)).rejects.toMatchObject({ name: "ArchiveFormatError", code: "archive-header-invalid" });
  });

  it.each([0, 1, 511, 512, 513])("accepts empty EOF and %i trailing zero bytes unchanged", async (padding) => {
    const bytes = Buffer.alloc(1024 + padding);
    expect(await meter(bytes, chunkSize)).toEqual(bytes);
  });

  it("rejects an empty stream without an EOF marker", async () => {
    await expect(meter(Buffer.alloc(0), chunkSize)).rejects.toThrow("missing two-block TAR EOF");
  });

  it.each(["L", "K", "D"])("keeps payload-carrying GNU type %s unchanged", async (type) => {
    const bytes = tarFixture([
      { path: "metadata", body: "name\0", mutateHeader: (header) => { header[156] = type.charCodeAt(0); } },
      { path: "value", body: "ok" },
    ]);
    expect(await meter(bytes, chunkSize)).toEqual(bytes);
  });

  it("uses PAX effective size to find EOF without changing bytes", async () => {
    const bytes = paxArchive([["size", "700"]], Buffer.alloc(700), 1);
    expect(await meter(bytes, chunkSize)).toEqual(bytes);
  });

  it.each(["000000000007", " 0000000007 ", "7\0          "])("accepts octal size %j", async (field) => {
    const bytes = tarFixture([{ path: "value", body: "payload", mutateHeader: (header) => { header.write(field, 124, "ascii"); } }]);
    expect(await meter(bytes, chunkSize)).toEqual(bytes);
  });

  it("accepts a full-width positive base-256 file size", async () => {
    const bytes = tarFixture([{ path: "value", body: "payload", mutateHeader: (header) => {
      header.fill(0, 124, 136); header[124] = 0x80; header[135] = 7;
    } }]);
    expect(await meter(bytes, chunkSize)).toEqual(bytes);
  });
});

describe("raw TAR logical entry counts", () => {
  const member = { path: "first", body: "payload" };
  const header = (size: number) => tarFixture([{
    path: "second", mutateHeader: (block) => { block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii"); },
  }], false);
  const limits = { maxEntries: 1 };
  const cases: Array<[string, Buffer, ArchiveExtractLimits, string]> = [
    ["zero count", header(0), { ...limits, maxEntries: 0 }, "archive-entry-count-exceeds-limit"],
    ["second member", Buffer.concat([tarFixture([member], false), header(1)]), limits, "archive-entry-count-exceeds-limit"],
    ["smaller PAX size still counts", Buffer.concat([tarFixture([paxHeader([["size", "0"]])], false), header(700), header(1)]), limits, "archive-entry-count-exceeds-limit"],
  ];

  it.each(cases)("rejects %s before asking its producer for body bytes", async (_label, prefix, options, code) => {
    const meter = new TarMetadataMeter(resolveTarMeterLimits(options));
    meter.resume();
    const error = new Promise<Error>((resolve) => meter.once("error", resolve));
    let bodyRequested = false;
    // The producer offers the next body only after admission acknowledges its
    // header. No body exists here: a late check would instead hit the tail trap.
    await new Promise<void>((resolve) => meter.write(prefix, (failure) => {
      if (!failure) { bodyRequested = true; meter.destroy(new Error("forbidden body tail")); }
      resolve();
    }));
    expect(await error).toMatchObject({ name: "ArchiveLimitError", code });
    expect(bodyRequested).toBe(false);
  });

  it("excludes PAX/GNU records and padding from logical counts", async () => {
    const bytes = Buffer.concat([
      tarFixture([paxHeader([["size", "0"]])], false), header(700),
      tarFixture([{ path: "LongName", type: "L", body: "name\0" }, { path: "LongLink", type: "K", body: "link\0" }, member]),
    ]);
    const meter = new TarMetadataMeter(resolveTarMeterLimits({ ...limits, maxEntries: 2 }));
    const output: Buffer[] = [];
    await pipeline(Readable.from([bytes]), meter, new Writable({ write(chunk, _encoding, callback) { output.push(chunk); callback(); } }));
    expect(Buffer.concat(output)).toEqual(bytes);
  });
});
