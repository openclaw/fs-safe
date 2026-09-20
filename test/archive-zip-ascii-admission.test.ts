import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { admitZipBuffer } from "../src/archive-zip-admission.js";
import { admitZipNames } from "../src/archive-zip-names.js";
import { loadZipArchiveWithPreflight } from "../src/archive-zip-preflight.js";
import type { ZipEntry } from "../src/archive-zip-entry.js";
import { unicodePath, zipRecords, type ZipRecord } from "./helpers/zip-records.js";

afterEach(() => vi.restoreAllMocks());

function nameBytes(value: string, shared: boolean): Buffer {
  if (!shared) return Buffer.from(value);
  const bytes = Buffer.from(new SharedArrayBuffer(Buffer.byteLength(value)));
  bytes.write(value);
  return bytes;
}

describe("UTF-8 flagged ASCII ZIP names", () => {
  for (const shared of [false, true]) {
    it.each([
      ["value", "value", "value", false, false],
      ["./pkg//value", "pkg\\.\\value", "pkg/value", false, false],
      ["pkg/value/", "pkg/value/", "pkg/value", true, true],
      ["pkg\\value\\", "pkg/value/", "pkg/value", true, true],
      ["pkg/value/", "pkg\\value\\", "pkg/value", false, true],
      [".", ".", "", false, false],
      ["./", "./", "", true, true],
      [".\\", ".\\", "", false, true],
      ["a".repeat(255), "a".repeat(255), "a".repeat(255), false, false],
    ] as const)(`preserves %j and its decoder key with shared=${shared}`, (central, local, key, portableDirectory, directory) => {
      expect(admitZipNames({
        central: nameBytes(central, shared), local: nameBytes(local, shared), flags: 0x800,
        centralExtra: new Map(), localExtra: new Map(), seen: new Set(),
      })).toEqual({ path: central, portableKey: key, portableDirectory, directory });
    });
  }

  it.each([
    "../escape", "nested/../escape", "nested\\..\\escape", "/absolute", "C:relative",
    "value\0tail", "a".repeat(256), Buffer.concat([Buffer.from("../"), Buffer.from([0xff])]),
  ])("keeps raw path rejection before decoding for %j", async name => {
    await expect(loadZipArchiveWithPreflight(zipRecords([{ name, flags: 0x800 }])))
      .rejects.toMatchObject({ code: "entry-path" });
  });

  it.each([
    { name: "value", localName: "other" },
    { name: "value/", localName: "value" },
    { name: "value", extra: unicodePath(Buffer.from("value"), "other") },
  ])("retains conflicting interpretation rejection for %j", async record => {
    await expect(loadZipArchiveWithPreflight(zipRecords([{ ...record, flags: 0x800 }])))
      .rejects.toMatchObject({ code: "archive-header-invalid" });
  });

  it.each([0, 0x800])("keeps matching ASCII Unicode fields and their CRC checks with flags=%s", async flags => {
    const name = "pkg/value";
    const extra = unicodePath(Buffer.from(name), name);
    const record = { name, flags, extra, localExtra: extra, body: "retained payload" };
    const archive = await loadZipArchiveWithPreflight(zipRecords([record]));
    expect(Object.keys(archive.files)).toEqual([name]);
    expect(await (archive.files[name] as ZipEntry).async("nodebuffer")).toEqual(Buffer.from("retained payload"));
    const invalid = Buffer.from(extra);
    invalid[5]! ^= 1;
    for (const changed of [{ ...record, extra: invalid }, { ...record, localExtra: invalid }]) {
      await expect(loadZipArchiveWithPreflight(zipRecords([changed])))
        .rejects.toMatchObject({ code: "archive-header-invalid", message: "invalid ZIP metadata: Unicode Path CRC mismatch" });
    }
  });

  it("retains collision rejection for flagged ASCII aliases in both orders", async () => {
    const records: ZipRecord[] = [{ name: "pkg/value", flags: 0x800 }, { name: "pkg\\value", flags: 0x800 }];
    for (const ordered of [records, records.toReversed()]) {
      await expect(loadZipArchiveWithPreflight(zipRecords(ordered))).rejects.toMatchObject({ code: "entry-path" });
    }
  });

  for (const changedName of ["central", "local"] as const) {
    it.each([
      ["invalid UTF-8", Buffer.from([0xff, 0x61, 0x66, 0x65]), "archive-header-invalid"],
      ["ASCII traversal", Buffer.from("../x"), "entry-path"],
    ] as const)(`revalidates shared ${changedName} bytes changed to %s after the Latin-1 snapshot`, (_label, replacement, code) => {
      const central = nameBytes("safe", changedName === "central");
      const local = nameBytes("safe", changedName === "local");
      const changed = changedName === "central" ? central : local;
      const toString = changed.toString;
      let captured = false;
      vi.spyOn(changed, "toString").mockImplementation((...args) => {
        const snapshot = Reflect.apply(toString, changed, args) as string;
        if (args[0] === "latin1" && !captured) {
          captured = true;
          replacement.copy(changed);
        }
        return snapshot;
      });
      expect(() => admitZipNames({
        central, local, flags: 0x800,
        centralExtra: new Map(), localExtra: new Map(), seen: new Set(),
      })).toThrow(expect.objectContaining({ code }));
      expect(captured).toBe(true);
    });
  }

  it("still rejects invalid UTF-8 after admitting an ASCII name", () => {
    expect(admitZipBuffer(zipRecords([{ name: "safe", flags: 0x800 }]), resolveExtractLimits())).toBe(1);
    expect(() => admitZipBuffer(zipRecords([{ name: Buffer.from([0xff]), flags: 0x800 }]), resolveExtractLimits()))
      .toThrow(expect.objectContaining({ code: "archive-header-invalid", message: "invalid ZIP metadata: invalid UTF-8 name" }));
  });
});
