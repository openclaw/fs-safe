import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { admitZipBuffer } from "../src/archive-zip-admission.js";
import type { ZipDirectoryEntry } from "../src/archive-zip-directory.js";
import { zipPathKey } from "../src/archive-zip-names.js";
import { loadZipArchiveWithPreflight } from "../src/archive-zip-preflight.js";
import { unicodePath, zipRecords, type ZipRecord } from "./helpers/zip-records.js";

afterEach(() => vi.restoreAllMocks());

const names = [
  { label: "ASCII", record: { name: "value" }, key: "value" },
  { label: "UTF-8 flag", record: { name: "café", flags: 0x800 }, key: "café" },
  { label: "unflagged UTF-8", record: { name: "café" }, key: "café" },
  { label: "legacy byte", record: { name: Buffer.from([0x82]) }, key: "\ufffd" },
  { label: "Unicode override", record: { name: "legacy", extra: unicodePath(Buffer.from("legacy"), "café") }, key: "café" },
  { label: "local Unicode field", record: { name: "café", localExtra: unicodePath(Buffer.from("café"), "café") }, key: "café" },
  { label: "nested alias", record: { name: "./pkg//value", localName: "pkg\\.\\value" }, key: "pkg/value" },
  { label: "UTF-8 alias", record: { name: "./pkg//café", localName: "pkg\\.\\café", flags: 0x800 }, key: "pkg/café" },
  { label: "Unicode alias", record: { name: "legacy", extra: unicodePath(Buffer.from("legacy"), "./pkg//café") }, key: "pkg/café" },
  { label: "slash directory", record: { name: "pkg/value/", attributes: 0x10, body: "" }, key: "pkg/value" },
  { label: "backslash directory", record: { name: "pkg\\value\\", attributes: 0x10, body: "" }, key: "pkg/value" },
  { label: "decomposed Unicode", record: { name: "cafe\u0301", flags: 0x800 }, key: "cafe\u0301" },
  { label: "BOM prefix", record: { name: "\ufeffvalue", flags: 0x800 }, key: "\ufeffvalue" },
] satisfies Array<{ label: string; record: ZipRecord; key: string }>;

describe("admitted ZIP portable keys", () => {
  it.each(names)("associates $label with the portable decoder", async ({ record, key }) => {
    const bytes = zipRecords([record]);
    const entries: ZipDirectoryEntry[] = [];
    expect(admitZipBuffer(bytes, resolveExtractLimits(), entry => { entries.push(entry); })).toBe(1);
    expect(entries[0]?.portableKey).toBe(key);
    await expect(loadZipArchiveWithPreflight(bytes)).resolves.toHaveProperty("files");
  });

  it.each([
    ["", ""], [".", ""], ["./", ""], [".\\", ""], ["././", ""],
    ["...", "..."], [".hidden", ".hidden"], ["value.", "value."],
    ["value/.", "value"], ["./pkg//value/", "pkg/value"], ["pkg\\.\\value\\", "pkg/value"],
    ["café", "café"], ["cafe\u0301", "cafe\u0301"],
  ])("preserves canonical identity for %j", (name, expected) => {
    expect(zipPathKey(name)).toBe(expected);
  });

  it.each([".", "./", ".\\", "././"])("keeps root identity for admitted %j", name => {
    const entries: ZipDirectoryEntry[] = [];
    admitZipBuffer(zipRecords([{ name }]), resolveExtractLimits(), entry => { entries.push(entry); });
    expect(entries[0]?.portableKey).toBe("");
  });

  it("continues to reject an empty physical name", () => {
    expect(() => admitZipBuffer(zipRecords([{ name: "" }]), resolveExtractLimits()))
      .toThrow(expect.objectContaining({ code: "archive-header-invalid" }));
  });

  it.each(["..", "C:value", "val\0ue", "a".repeat(256)])("validates raw single-component name %j", async name => {
    expect(() => admitZipBuffer(zipRecords([{ name }]), resolveExtractLimits()))
      .toThrow(expect.objectContaining({ code: "entry-path" }));
    const bytes = zipRecords([{ name: "value" }]);
    const load = JSZip.prototype.loadAsync;
    vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
      const archive = await load.apply(this, args);
      archive.files.value!.name = name;
      return archive;
    });
    await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "entry-path" });
  });

  it.each([
    [{ name: "value" }, { name: "./value" }],
    [{ name: "pkg/value" }, { name: "pkg\\value" }],
    [{ name: "." }, { name: "./" }],
    [{ name: "legacy", extra: unicodePath(Buffer.from("legacy"), "café") }, { name: "café", flags: 0x800 }],
  ] satisfies ZipRecord[][])("rejects raw/Unicode collisions before decoder loading: %j", async (...records) => {
    const load = vi.spyOn(JSZip.prototype, "loadAsync");
    for (const entries of [records, records.toReversed()]) {
      await expect(loadZipArchiveWithPreflight(zipRecords(entries))).rejects.toMatchObject({ code: "entry-path" });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects collisions created by the portable legacy decoder", async () => {
    const bytes = zipRecords([{ name: Buffer.from([0x82]) }, { name: Buffer.from([0x83]) }]);
    expect(admitZipBuffer(bytes, resolveExtractLimits())).toBe(2);
    await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "entry-path" });
  });

  it("rejects an entry-name mismatch after canonical association", async () => {
    const bytes = zipRecords([{ name: "value" }]);
    const load = JSZip.prototype.loadAsync;
    vi.spyOn(JSZip.prototype, "loadAsync").mockImplementation(async function(this: JSZip, ...args) {
      const archive = await load.apply(this, args);
      archive.files.value!.name = "other";
      return archive;
    });
    await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "archive-header-invalid" });
  });
});
