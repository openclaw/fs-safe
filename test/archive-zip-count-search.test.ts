import { describe, expect, it } from "vitest";
import { readZipCentralDirectoryEntryCount } from "../src/archive-zip-preflight.js";
import { zipRecords } from "./helpers/zip-records.js";

const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

describe("ZIP count hint end-record search", () => {
  it.each([0, 1, 3, 4, 21, 22, 65_534, 65_535])("counts through %i comment bytes", (length) => {
    const bytes = zipRecords([{ name: "one" }, { name: "two" }], {
      comment: Buffer.alloc(length, 0x61),
    });
    expect(readZipCentralDirectoryEntryCount(bytes)).toBe(2);
    const backing = Buffer.concat([Buffer.alloc(17), bytes, Buffer.alloc(11)]);
    expect(readZipCentralDirectoryEntryCount(new Uint8Array(
      backing.buffer, backing.byteOffset + 17, bytes.length,
    ))).toBe(2);
  });

  it.each([1, 15, 16, 17, 1000])("ignores %i false signatures before the end", (count) => {
    const comment = Buffer.alloc(count * 24 + 4, 0xff);
    for (let offset = 0; offset < comment.length; offset += 24) signature.copy(comment, offset);
    const bytes = zipRecords([{ name: "one" }], { comment });
    expect(readZipCentralDirectoryEntryCount(bytes)).toBe(1);
  });

  it("retains the latest valid record as a hint when more than one fits", () => {
    const comment = Buffer.alloc(128);
    for (const [offset, count] of [[32, 3], [64, 7]]) {
      signature.copy(comment, offset);
      comment.writeUInt16LE(count!, offset! + 10);
      comment.writeUInt16LE(comment.length - offset! - 22, offset! + 20);
    }
    expect(readZipCentralDirectoryEntryCount(zipRecords([{ name: "one" }], { comment }))).toBe(7);
  });

  it("retains a valid zero-comment record at the last possible offset", () => {
    const comment = Buffer.alloc(44);
    signature.copy(comment, 22);
    comment.writeUInt16LE(9, 32);
    expect(readZipCentralDirectoryEntryCount(zipRecords([{ name: "one" }], { comment }))).toBe(9);
  });

  it("returns no hint for truncated records or a comment beyond the bounded window", () => {
    for (let length = 0; length < 22; length++) {
      const bytes = Buffer.alloc(length);
      signature.copy(bytes);
      expect(readZipCentralDirectoryEntryCount(bytes)).toBeNull();
    }
    const bytes = zipRecords([], { comment: Buffer.alloc(65_535, 0x61) });
    expect(readZipCentralDirectoryEntryCount(Buffer.concat([bytes, Buffer.from("a")]))).toBeNull();
    expect(readZipCentralDirectoryEntryCount(Buffer.alloc(128 * 1024, 0x61))).toBeNull();
  });
});
