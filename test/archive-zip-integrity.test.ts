import fs from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveFormatError,
  ArchiveLimitError,
  extractArchive,
  readArchiveEntry,
} from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative as native } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const payload = Buffer.from("0123456789ABCDEF");
const payloadCrc = 0x983c37b5;
const { tempRoot } = useTempDirs();

// Standalone physical records with matching local/central metadata; only the
// declared output size or CRC differs from the actual payload in corrupt cases.
function zipFixture(method: 0 | 8, declaredSize = payload.length, checksum = payloadCrc, body = payload): Buffer {
  const name = Buffer.from("selected");
  const compressed = method === 8 ? deflateRawSync(body) : body;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

async function expectFormatError(operation: Promise<unknown>) {
  await expect(operation).rejects.toBeInstanceOf(ArchiveFormatError);
  await expect(operation).rejects.toMatchObject({ code: "archive-header-invalid" });
}

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "auto", "require"] as const) {
  describe.skipIf(mode !== "off" && !native)(`ZIP payload integrity ${mode}`, () => {
    let read: ReturnType<typeof vi.fn>;
    let extract: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode !== "off") {
        // The shared loader uses native/<host artifact>, never a registry binary.
        // FS_SAFE_NATIVE_MODE=require makes a missing local build fail the suite.
        read = vi.fn(native!.readArchiveEntryNative.bind(native));
        extract = vi.fn(native!.extractArchiveNative.bind(native));
        __setNativeLoaderForTest(() => ({
          ...native!, readArchiveEntryNative: read, extractArchiveNative: extract,
        }));
      }
    });

    async function fixture(bytes: Buffer) {
      const root = await tempRoot("fs-safe-zip-integrity-");
      const archivePath = path.join(root, "fixture.zip");
      const destDir = path.join(root, "output");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind: "zip" as const, timeoutMs: 10_000 };
    }

    async function expectUnpublished(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      if (mode !== "off") expect(extract).toHaveBeenCalledTimes(1);
    }

    describe.each([0, 8] as const)("method %s", (method) => {
      it.each([1, 100])("rejects selected reads declaring %s bytes with a generous cap", async (declaredSize) => {
        const { archivePath } = await fixture(zipFixture(method, declaredSize));
        const operation = readArchiveEntry(archivePath, "selected", { maxBytes: 128 });
        await expectFormatError(operation);
        if (mode !== "off") expect(read).toHaveBeenCalledTimes(1);
      });

      it.each([1, 100])("rejects extraction declaring %s bytes without publishing", async (declaredSize) => {
        const input = await fixture(zipFixture(method, declaredSize));
        await expectFormatError(extractArchive(input));
        await expectUnpublished(input.destDir);
      });

      it.each([1, 16, 100])("enforces maxBytes=1 with declared size %s", async (declaredSize) => {
        const { archivePath } = await fixture(zipFixture(method, declaredSize));
        const operation = readArchiveEntry(archivePath, "selected", { maxBytes: 1 });
        await expect(operation).rejects.toBeInstanceOf(ArchiveLimitError);
        await expect(operation).rejects.toMatchObject({
          code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
        });
        if (mode !== "off") expect(read).toHaveBeenCalledTimes(1);
      });

      it("reads and extracts a correctly sized payload", async () => {
        expect(payload.length).toBe(16);
        expect(crc32(payload)).toBe(payloadCrc);
        const input = await fixture(zipFixture(method));
        for (const maxBytes of [16, 128]) {
          expect(await readArchiveEntry(input.archivePath, "selected", { maxBytes })).toEqual(payload);
        }
        await extractArchive(input);
        expect(await fs.readFile(path.join(input.destDir, "selected"))).toEqual(payload);
        if (mode !== "off") {
          expect(read).toHaveBeenCalledTimes(2);
          expect(extract).toHaveBeenCalledTimes(1);
        }
      });

      it("rejects a bad CRC even with the correct declared size", async () => {
        const { archivePath } = await fixture(zipFixture(method, 16, (payloadCrc ^ 1) >>> 0));
        for (const maxBytes of [16, 128]) {
          await expect(readArchiveEntry(archivePath, "selected", { maxBytes })).rejects.toThrow();
        }
        if (mode !== "off") expect(read).toHaveBeenCalledTimes(2);
      });

      it("rejects bad-CRC extraction without publishing", async () => {
        const input = await fixture(zipFixture(method, 16, (payloadCrc ^ 1) >>> 0));
        await expect(extractArchive(input)).rejects.toThrow();
        await expectUnpublished(input.destDir);
      });

      it("reads a valid empty entry at maxBytes=0 and extracts it", async () => {
        const empty = Buffer.alloc(0);
        const input = await fixture(zipFixture(method, 0, 0, empty));
        expect(await readArchiveEntry(input.archivePath, "selected", { maxBytes: 0 })).toEqual(empty);
        await extractArchive(input);
        expect(await fs.readFile(path.join(input.destDir, "selected"))).toEqual(empty);
        if (mode !== "off") {
          expect(read).toHaveBeenCalledTimes(1);
          expect(extract).toHaveBeenCalledTimes(1);
        }
      });
    });
  });
}
