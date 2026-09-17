import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function exactZipFiles(bytes, expectedNames) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 22, "analysis artifact ZIP is truncated");
  const searchStart = Math.max(0, bytes.length - 22 - 0xffff);
  const candidates = [];
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      candidates.push(offset);
    }
  }
  assert.equal(candidates.length, 1, "analysis artifact ZIP end record is ambiguous");
  const end = candidates[0];
  const disk = bytes.readUInt16LE(end + 4);
  const centralDisk = bytes.readUInt16LE(end + 6);
  const diskEntries = bytes.readUInt16LE(end + 8);
  const entries = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  assert.equal(disk, 0, "multi-disk analysis artifact ZIP is inadmissible");
  assert.equal(centralDisk, 0, "multi-disk analysis artifact ZIP is inadmissible");
  assert.equal(diskEntries, entries, "analysis artifact ZIP entry count is inconsistent");
  assert(![diskEntries, entries].includes(0xffff) &&
    ![centralSize, centralOffset].includes(0xffffffff),
  "ZIP64 analysis artifacts are outside the sealed format");
  assert.equal(entries, expectedNames.length, "analysis artifact ZIP entry count changed");
  assert.equal(centralOffset + centralSize, end,
    "analysis artifact ZIP central directory is misplaced");

  const files = new Map();
  const ranges = [];
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    assert(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50,
      "analysis artifact ZIP central entry is invalid");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    assert(centralEnd <= end, "analysis artifact ZIP central entry is truncated");
    assert.equal(startDisk, 0, "multi-disk analysis artifact ZIP entry is inadmissible");
    assert((flags & 0x0001) === 0, "encrypted analysis artifact ZIP is inadmissible");
    assert(method === 0 || method === 8, "analysis artifact ZIP compression changed");
    assert(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff &&
      localOffset !== 0xffffffff, "ZIP64 analysis artifact entry is outside the sealed format");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    assert(Buffer.from(name, "utf8").equals(nameBytes),
      "analysis artifact ZIP filename is not canonical UTF-8");
    assert(expectedNames.includes(name) && !files.has(name),
      `analysis artifact ZIP contains an unexpected or duplicate path: ${name}`);

    assert(localOffset + 30 <= centralOffset && bytes.readUInt32LE(localOffset) === 0x04034b50,
      `analysis artifact ZIP local entry is invalid: ${name}`);
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    assert(dataEnd <= centralOffset, `analysis artifact ZIP data is truncated: ${name}`);
    assert.equal(localFlags, flags, `analysis artifact ZIP flags changed: ${name}`);
    assert.equal(localMethod, method, `analysis artifact ZIP method changed: ${name}`);
    assert(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes),
      `analysis artifact ZIP local filename changed: ${name}`);
    if ((flags & 0x0008) === 0) {
      assert.equal(localCrc, expectedCrc, `analysis artifact ZIP CRC header changed: ${name}`);
      assert.equal(localCompressedSize, compressedSize,
        `analysis artifact ZIP compressed size changed: ${name}`);
      assert.equal(localUncompressedSize, uncompressedSize,
        `analysis artifact ZIP uncompressed size changed: ${name}`);
    } else {
      assert(localCrc === 0 || localCrc === expectedCrc,
        `analysis artifact ZIP deferred CRC changed: ${name}`);
      assert(localCompressedSize === 0 || localCompressedSize === compressedSize,
        `analysis artifact ZIP deferred compressed size changed: ${name}`);
      assert(localUncompressedSize === 0 || localUncompressedSize === uncompressedSize,
        `analysis artifact ZIP deferred uncompressed size changed: ${name}`);
    }
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const content = method === 0 ? Buffer.from(compressed) :
      inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
    assert.equal(content.length, uncompressedSize,
      `analysis artifact ZIP uncompressed size is invalid: ${name}`);
    assert.equal(crc32(content), expectedCrc,
      `analysis artifact ZIP content CRC is invalid: ${name}`);
    files.set(name, content);
    ranges.push([localOffset, dataEnd]);
    cursor = centralEnd;
  }
  assert.equal(cursor, end, "analysis artifact ZIP central directory size changed");
  ranges.sort(([left], [right]) => left - right);
  for (let index = 1; index < ranges.length; index += 1) {
    assert(ranges[index - 1][1] <= ranges[index][0],
      "analysis artifact ZIP entries overlap");
  }
  assert.deepEqual([...files.keys()].sort(), [...expectedNames].sort(),
    "analysis artifact ZIP file set changed");
  return files;
}

export function assertExactZipExtraction(bytes, expectedNames, extractedFiles) {
  assert(extractedFiles instanceof Map, "extracted analysis artifact file map is required");
  assert.deepEqual([...extractedFiles.keys()].sort(), [...expectedNames].sort(),
    "extracted analysis artifact file set changed");
  const archivedFiles = exactZipFiles(bytes, expectedNames);
  for (const name of expectedNames) {
    const extracted = extractedFiles.get(name);
    assert(Buffer.isBuffer(extracted), `extracted analysis artifact file is invalid: ${name}`);
    assert(extracted.equals(archivedFiles.get(name)),
      `extracted aggregate evidence differs from the selected archive: ${name}`);
  }
  return archivedFiles;
}

export function typedFlatDirectoryHash(files) {
  assert(files instanceof Map, "captured flat directory file map is required");
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name);
    assert(Buffer.isBuffer(bytes), `captured flat directory file is invalid: ${name}`);
    hash.update("file\0").update(name).update("\0")
      .update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

export function assertCapturedFlatDirectoryHash(files, liveDirectoryHash, context) {
  assert.match(liveDirectoryHash ?? "", /^[0-9a-f]{64}$/u,
    `${context} live directory hash is invalid`);
  const capturedDirectoryHash = typedFlatDirectoryHash(files);
  assert.equal(liveDirectoryHash, capturedDirectoryHash,
    `${context} changed after its verified capture`);
  return capturedDirectoryHash;
}
