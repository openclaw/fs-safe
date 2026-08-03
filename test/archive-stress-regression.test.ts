import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveFormatError,
  extractArchive,
  readArchiveEntry,
} from "../src/archive.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";

const { tempRoot } = useTempDirs();

beforeEach(() => configureFsSafeNative({ mode: "off" }));

afterEach(async () => {
  __resetFsSafeNativeConfigForTest();
});


function duplicateOnlyZipEntry(bytes: Buffer): Buffer {
  const eocd = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("ZIP fixture has no end-of-central-directory record");
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const local = bytes.subarray(0, centralOffset);
  const central = bytes.subarray(centralOffset, centralOffset + centralSize);
  const secondCentral = Buffer.from(central);
  secondCentral.writeUInt32LE(local.byteLength, 42);
  const nextEocd = Buffer.from(bytes.subarray(eocd));
  nextEocd.writeUInt16LE(2, 8);
  nextEocd.writeUInt16LE(2, 10);
  nextEocd.writeUInt32LE(centralSize * 2, 12);
  nextEocd.writeUInt32LE(local.byteLength * 2, 16);
  return Buffer.concat([local, local, central, secondCentral, nextEocd]);
}

describe("archive stress regressions", () => {
  it.each([
    ["case", "Payload.txt", "payload.txt"],
    ["Unicode normalization", "caf\u00e9.txt", "cafe\u0301.txt"],
  ])("rejects %s-equivalent zip output names", async (_label, firstName, secondName) => {
    const root = await tempRoot("fs-safe-archive-portable-collision-");
    const archivePath = path.join(root, "payload.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir);
    const zip = new JSZip();
    zip.file(firstName, "first");
    zip.file(secondName, "second");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });

  it.each(["C:secret.txt", "nested/C:secret.txt"])(
    "rejects drive-relative zip entry %s without destination debris",
    async (entryName) => {
      const root = await tempRoot("fs-safe-archive-drive-relative-");
      const archivePath = path.join(root, "payload.zip");
      const destDir = path.join(root, "dest");
      await fs.mkdir(destDir);
      const zip = new JSZip();
      zip.file(entryName, "secret");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expect(
        extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
      ).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
      await expect(fs.readdir(destDir)).resolves.toEqual([]);
    },
  );

  it("honors an explicit zero entry budget", async () => {
    const root = await tempRoot("fs-safe-archive-zero-limit-");
    const archivePath = path.join(root, "payload.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir);
    const zip = new JSZip();
    zip.file("payload.txt", "payload");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      extractArchive({
        archivePath,
        destDir,
        kind: "zip",
        timeoutMs: 15_000,
        limits: { maxEntries: 0 },
      }),
    ).rejects.toMatchObject({ code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT });
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });

  it("rejects a zip entry whose payload does not match its CRC", async () => {
    const root = await tempRoot("fs-safe-archive-crc-");
    const archivePath = path.join(root, "payload.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir);
    const zip = new JSZip();
    zip.file("payload.txt", "payload");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const localHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(localHeader).toBeGreaterThanOrEqual(0);
    expect(centralHeader).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(0, localHeader + 14);
    bytes.writeUInt32LE(0, centralHeader + 16);
    await fs.writeFile(archivePath, bytes);

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
    ).rejects.toBeInstanceOf(ArchiveFormatError);
    await expect(readArchiveEntry(archivePath, "payload.txt", { maxBytes: 16, kind: "zip" }))
      .rejects.toBeInstanceOf(ArchiveFormatError);
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });

  it("rejects duplicate zip entry names for extraction and bounded reads", async () => {
    const root = await tempRoot("fs-safe-archive-duplicate-");
    const archivePath = path.join(root, "duplicate.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir);
    const zip = new JSZip();
    zip.file("payload.txt", "payload");
    const duplicate = duplicateOnlyZipEntry(
      await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }),
    );
    await fs.writeFile(archivePath, duplicate);

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    await expect(readArchiveEntry(archivePath, "payload.txt", { maxBytes: 16, kind: "zip" }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });
});
