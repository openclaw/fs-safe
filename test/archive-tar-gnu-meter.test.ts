import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { TarParserStream } from "../src/archive-tar-wasm.js";
import { gnu, gnuFixture, invalidGnu, validGnu } from "./helpers/archive-gnu.js";
import { tarFixture } from "./helpers/archive-fuzz.js";

async function meter(bytes: Buffer, chunkSize: number, maxMetaEntryBytes = 1024): Promise<Buffer> {
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  }
  const output: Buffer[] = [];
  await pipeline(Readable.from(chunks()), new TarParserStream(resolveTarMeterLimits({ maxMetaEntryBytes })), new Writable({
    write(chunk: Buffer, _encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}

describe.each([1, 511, 513, 4096])("GNU raw admission chunks=%i", (chunkSize) => {
  it.each(invalidGnu)("rejects $name before parser normalization", async ({ entries, code }) => {
    await expect(meter(gnuFixture(entries), chunkSize)).rejects.toMatchObject({
      name: code === "entry-path" ? "ArchiveSecurityError" : "ArchiveFormatError", code,
    });
  });
  it.each(validGnu)("forwards $name byte-for-byte", async ({ entries }) => {
    const bytes = gnuFixture(entries);
    expect(await meter(bytes, chunkSize)).toEqual(bytes);
  });
  it.each(["L", "K"] as const)("rejects dangling %s without EOF or with a truncated body", async (type) => {
    const bytes = tarFixture([gnu(type, "name\0")], false);
    for (const prefix of [bytes, bytes.subarray(0, 514)]) {
      await expect(meter(prefix, chunkSize)).rejects.toMatchObject({ name: "ArchiveFormatError", code: "archive-header-invalid" });
    }
  });
  it.each(["L", "K"] as const)("charges the exact %s body length, including a terminal NUL", async (type) => {
    const bytes = gnuFixture([gnu(type, "name\0"), { path: "raw" }]);
    expect(await meter(bytes, chunkSize, 5)).toEqual(bytes);
    await expect(meter(bytes, chunkSize, 4)).rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-meta-entry-size-exceeds-limit" });
  });
});
