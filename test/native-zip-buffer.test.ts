import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { readBoundedAsync } from "../src/bounded-read.js";
import * as temp from "../src/temp-target.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it.each([0, 1, 7, 64 * 1024])("keeps an unpooled bounded read private after a short read (%s bytes)", async length => {
  const source = Buffer.alloc(length, 42);
  let offset = 0;
  const result = await readBoundedAsync(length, async (buffer, capacity) => {
    const count = Math.min(capacity, source.length - offset, 3);
    source.copy(buffer, 0, offset, offset + count);
    offset += count;
    return count;
  }, { unpooled: true, initialSize: 1024 });
  expect(result).toEqual(source);
  expect(result.byteOffset).toBe(0);
  expect(result.buffer.byteLength).toBeLessThanOrEqual(Math.max(length * 2, 1));
});

describe.skipIf(!native)("native buffered ZIP reads", () => {
  it.each(["STORE", "DEFLATE"] as const)("reads %s without disk staging and keeps admitted bytes across source replacement", async compression => {
    const dir = await tempRoot("fs-safe-native-buffer-");
    const archivePath = path.join(dir, "input.zip");
    const payload = Buffer.alloc(8192, 42);
    const zip = new JSZip();
    zip.file("payload", payload);
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer", compression }));
    const open = vi.fn(async (buffer: Buffer, limits: Parameters<NativeBinding["openZipBufferNative"]>[1]) => {
      expect(buffer.byteOffset).toBe(0);
      expect(buffer.buffer.byteLength).toBeLessThanOrEqual(buffer.length + 1);
      const reader = await native!.openZipBufferNative(buffer, limits);
      await fs.writeFile(archivePath, "replaced after admission");
      return reader;
    });
    __setNativeLoaderForTest(() => ({ ...native!, openZipBufferNative: open }));
    configureFsSafeNative({ mode: "require" });
    const staging = vi.spyOn(temp, "tempFile").mockRejectedValue(new Error("temporary storage unavailable"));
    await expect(readArchiveEntry(archivePath, "payload", { maxBytes: payload.length })).resolves.toEqual(payload);
    expect(open).toHaveBeenCalledTimes(1);
    expect(staging).not.toHaveBeenCalled();
  });

  it.each(["limit", "crc", "missing", "declared-size"])("retains %s rejection without staging", async failure => {
    const dir = await tempRoot("fs-safe-native-buffer-errors-");
    const archivePath = path.join(dir, "input.zip");
    const zip = new JSZip(); zip.file("payload", "original bytes");
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: failure === "declared-size" ? "DEFLATE" : "STORE" });
    if (failure === "crc") bytes[30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)]! ^= 1;
    if (failure === "declared-size") {
      bytes.writeUInt32LE(100, 22);
      bytes.writeUInt32LE(100, bytes.readUInt32LE(bytes.length - 6) + 24);
    }
    await fs.writeFile(archivePath, bytes);
    configureFsSafeNative({ mode: "require" });
    const staging = vi.spyOn(temp, "tempFile").mockRejectedValue(new Error("temporary storage unavailable"));
    const pending = readArchiveEntry(archivePath, failure === "missing" ? "absent" : "payload", {
      maxBytes: failure === "limit" ? 1 : failure === "declared-size" ? 16 : 100,
    });
    if (failure === "missing") await expect(pending).rejects.toThrow("archive entry not found");
    else if (failure === "crc") await expect(pending).rejects.toThrow(/checksum/i);
    else await expect(pending).rejects.toMatchObject({
      code: failure === "limit" ? "archive-entry-extracted-size-exceeds-limit" : "archive-header-invalid",
    });
    expect(staging).not.toHaveBeenCalled();
  });

  it("retains the archive across concurrent reads and validates direct byte budgets", async () => {
    const zip = new JSZip(); zip.file("payload", "read repeatedly");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
    const reader = await native!.openZipBufferNative(owned, resolveTarMeterLimits());
    expect(reader.entries).toMatchObject([{ path: "payload", index: 0, kind: "file", size: 15 }]);
    const results = await Promise.all(Array.from({ length: 12 }, () => reader.readEntry(0, 15)));
    for (const result of results) expect(result.toString()).toBe("read repeatedly");
    for (const max of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => reader.readEntry(0, max)).toThrow();
    }
    await expect(reader.readEntry(0, 14)).rejects.toThrow();
    await expect(reader.readEntry(1, 15)).rejects.toThrow();
    const readAbort = new AbortController();
    const reading = reader.readEntry(0, 15, readAbort.signal);
    readAbort.abort();
    await expect(reading).rejects.toThrow();
    const openAbort = new AbortController();
    const opening = native!.openZipBufferNative(owned, resolveTarMeterLimits(), openAbort.signal);
    openAbort.abort();
    await expect(opening).rejects.toThrow();
  });
});
