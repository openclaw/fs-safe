import { describe, expect, it } from "vitest";
import {
  assertCapturedFlatDirectoryHash,
  assertExactZipExtraction,
  crc32,
  exactZipFiles,
  typedFlatDirectoryHash,
} from "../benchmarks/exact-artifact-zip.mjs";

function storedZip(files: ReadonlyMap<string, Buffer>): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localRecords.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + content.length;
  }
  const localBytes = Buffer.concat(localRecords);
  const centralBytes = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

describe("exact Actions artifact ZIP evidence", () => {
  const files = new Map([
    ["analysis.json", Buffer.from('{"accepted":true}\n')],
    ["artifacts-api.json", Buffer.from('{"artifacts":[]}\n')],
    ["campaign-manifest.json", Buffer.from('{"schema":"manifest"}\n')],
    ["jobs-api.json", Buffer.from('{"jobs":[]}\n')],
    ["run-api.json", Buffer.from('{"id":123}\n')],
  ]);

  it("derives the exact file inventory and bytes from a retained ZIP", () => {
    const archive = storedZip(files);
    expect(Object.fromEntries(exactZipFiles(archive, [...files.keys()])))
      .toEqual(Object.fromEntries(files));
    expect(() => assertExactZipExtraction(archive, [...files.keys()], files)).not.toThrow();
  });

  it("rejects a changed archive", () => {
    const archive = storedZip(files);
    const offset = 30 + Buffer.byteLength("analysis.json");
    archive.writeUInt8(archive.readUInt8(offset) ^ 1, offset);
    expect(() => exactZipFiles(archive, [...files.keys()])).toThrow("CRC");
  });

  it("rejects changed extracted analysis even when the retained ZIP is intact", () => {
    const extracted = new Map(files);
    extracted.set("analysis.json", Buffer.from('{"accepted":false}\n'));
    expect(() => assertExactZipExtraction(storedZip(files), [...files.keys()], extracted))
      .toThrow("differs from the selected archive");
  });

  it("derives the sealed directory hash from the ZIP-verified captured bytes", () => {
    const capturedHash = typedFlatDirectoryHash(files);
    expect(assertCapturedFlatDirectoryHash(files, capturedHash, "aggregate evidence"))
      .toBe(capturedHash);
    const changedAfterCapture = new Map(files);
    changedAfterCapture.set("analysis.json", Buffer.from('{"accepted":false}\n'));
    expect(() => assertCapturedFlatDirectoryHash(
      files,
      typedFlatDirectoryHash(changedAfterCapture),
      "aggregate evidence",
    )).toThrow("changed after its verified capture");
  });
});
