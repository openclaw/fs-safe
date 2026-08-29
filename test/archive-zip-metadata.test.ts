import { describe, expect, it } from "vitest";
import { admitZipBuffer } from "../src/archive-zip-admission.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { loadZipArchiveWithPreflight, readZipCentralDirectoryEntryCount } from "../src/archive-zip-preflight.js";
import { zipRecords, unicodePath, zipExtra } from "./helpers/zip-records.js";

const limits = resolveExtractLimits();
const admit = (bytes: Uint8Array) => admitZipBuffer(bytes, limits);
function malformed(bytes: Buffer) {
  expect(() => admit(bytes)).toThrow(expect.objectContaining({ code: "archive-header-invalid" }));
}
const name = Buffer.from("name");
const unicode = unicodePath(name, "é");

describe("ZIP metadata framing and encoding", () => {
  it.each([
    { name: "é", flags: 0x800 },
    { name, extra: unicode, localExtra: unicode },
    { name, extra: unicode },
    { name: "./path//file", localName: "path/file" },
    { name: "path\\file", localName: "path/file" },
    { name: Buffer.from([0x82]) },
  ])("preserves accepted names without choosing a global encoding: %j", async (entry) => {
    const bytes = zipRecords([entry]);
    expect(admit(bytes)).toBe(1);
    expect(Object.keys((await loadZipArchiveWithPreflight(bytes)).files)).toHaveLength(1);
  });
  it("preserves classic prefixes, empty archives, views, and count hints", async () => {
    const bytes = zipRecords([{ name: "good" }], { prefix: Buffer.from("self-extracting prefix") });
    expect(admit(bytes)).toBe(1);
    expect(Object.keys((await loadZipArchiveWithPreflight(bytes)).files)).toEqual(["good"]);
    const backing = Buffer.concat([Buffer.alloc(13, 255), bytes, Buffer.alloc(9, 255)]);
    expect(admit(new Uint8Array(backing.buffer, backing.byteOffset + 13, bytes.length))).toBe(1);
    expect(admit(zipRecords([]))).toBe(0);
    expect(await loadZipArchiveWithPreflight(zipRecords([]))).toMatchObject({ files: {} });
    expect(readZipCentralDirectoryEntryCount(Buffer.from("invalid"))).toBeNull();
  });
  it("accepts ordinary ZIP64 local offsets and a ZIP64 archive prefix in fallback", async () => {
    for (const prefix of [Buffer.alloc(0), Buffer.from("prefix")]) {
      const bytes = zipRecords([{ name: "first", zip64: true }, { name: "second", zip64: true }], { zip64: true, prefix });
      expect(admit(bytes)).toBe(2);
      expect(Object.keys((await loadZipArchiveWithPreflight(bytes)).files)).toEqual(["first", "second"]);
    }
  });
  it.each(["crc", "version", "short", "utf8", "duplicate", "local-only"])("rejects invalid Unicode metadata: %s", (variant) => {
    let extra = Buffer.from(unicode); let localExtra: Buffer | undefined;
    if (variant === "crc") extra[5] ^= 1;
    if (variant === "version") extra[4] = 2;
    if (variant === "short") extra = zipExtra(0x7075, Buffer.alloc(4));
    if (variant === "utf8") extra[9] = 0xff;
    if (variant === "duplicate") extra = Buffer.concat([extra, extra]);
    if (variant === "local-only") { localExtra = extra; extra = Buffer.alloc(0); }
    malformed(zipRecords([{ name, extra, localExtra }]));
  });
  it("rejects invalid flagged UTF8 and conflicting local Unicode", () => {
    malformed(zipRecords([{ name: Buffer.from([0xff]), flags: 0x800 }]));
    malformed(zipRecords([{ name, extra: unicode, localExtra: unicodePath(name, "other") }]));
    malformed(zipRecords([{ name: "other", localName: name, extra: unicodePath(Buffer.from("other"), "é"), localExtra: unicode }]));
  });
  it.each(["end", "local", "central", "offset", "size", "count", "disk", "flags", "extra", "descriptor", "placeholder"])("rejects impossible framing: %s", (variant) => {
    const bytes = zipRecords([{ name: "good", descriptor: variant === "descriptor" || variant === "placeholder" }]);
    const end = bytes.length - 22; const central = bytes.readUInt32LE(end + 16);
    if (variant === "end") return malformed(bytes.subarray(0, -1));
    if (variant === "local") bytes[0] = 0;
    if (variant === "central") bytes[central] = 0;
    if (variant === "offset") bytes.writeUInt32LE(central + 1, central + 42);
    if (variant === "size") bytes.writeUInt32LE(0xfffffffe, central + 20);
    if (variant === "count") { bytes.writeUInt16LE(0, end + 8); bytes.writeUInt16LE(0, end + 10); }
    if (variant === "disk") bytes.writeUInt16LE(1, central + 34);
    if (variant === "flags") { bytes.writeUInt16LE(1, 6); bytes.writeUInt16LE(1, central + 8); }
    if (variant === "extra") return malformed(zipRecords([{ name: "good", extra: Buffer.from([1, 0, 8, 0]) }]));
    if (variant === "descriptor") bytes[central - 12] ^= 1;
    if (variant === "placeholder") bytes.writeUInt32LE(1, 14);
    malformed(bytes);
  });
  it.each(["locator", "unsafe", "body", "extra", "duplicate"])("rejects malformed ZIP64: %s", (variant) => {
    const bytes = zipRecords([{ name: "good", zip64: true, extra: variant === "duplicate" ? zipExtra(1, Buffer.alloc(24)) : undefined }], { zip64: true });
    const record = bytes.length - 98;
    if (variant === "locator") bytes.writeBigUInt64LE(0n, bytes.length - 34);
    if (variant === "unsafe") bytes.writeBigUInt64LE(2n ** 60n, record + 48);
    if (variant === "body") bytes.writeBigUInt64LE(45n, record + 4);
    if (variant === "extra") bytes.writeUInt16LE(0, 36);
    malformed(bytes);
  });
  it("rejects overlapping references, ambiguous ends, and hidden physical counts", () => {
    const bytes = zipRecords([{ name: "same" }, { name: "diff" }]);
    const central = bytes.readUInt32LE(bytes.length - 6);
    const second = central + 50;
    bytes.writeUInt32LE(0, second + 42);
    malformed(bytes);
    const inner = zipRecords([]); const outer = zipRecords([], { comment: inner });
    malformed(outer);
    expect(() => admitZipBuffer(zipRecords([{ name: "a" }, { name: "b" }], { declaredCount: 0 }), resolveExtractLimits({ maxEntries: 1 }))).toThrow(expect.objectContaining({ code: "archive-entry-count-exceeds-limit" }));
  });
});
