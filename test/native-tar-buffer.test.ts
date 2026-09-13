import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { validateGzipBufferTail } from "../src/archive-gzip-tail.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import * as temp from "../src/temp-target.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxNative as native } from "./helpers/archive-pax-native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const payload = Buffer.alloc(128 * 1024, 42);
const fixture = tarFixture([{ path: "earlier", body: "skip" }, { path: "payload", body: payload }, { path: "directory", type: "5" }]);
function own(bytes: Buffer): Buffer {
  const input = Buffer.allocUnsafeSlow(bytes.length);
  bytes.copy(input);
  return input;
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !native)(`buffered TAR mode=${mode}`, () => {
    it.each([false, true])("reads without temporary storage (gzip=%s)", async gzip => {
      configureFsSafeNative({ mode });
      const dir = await tempRoot("fs-safe-tar-buffer-");
      const archivePath = path.join(dir, gzip ? "input.tar.gz" : "input.tar");
      await fs.writeFile(archivePath, gzip ? gzipSync(fixture) : fixture);
      const staging = vi.spyOn(temp, "tempFile").mockRejectedValue(new Error("temporary storage unavailable"));
      const open = vi.fn(async (...args: Parameters<NativeBinding["openTarBufferNative"]>) => {
        expect(args[0].byteOffset).toBe(0);
        expect(args[0].buffer.byteLength).toBeLessThanOrEqual(args[0].length + 1);
        const reader = await native!.openTarBufferNative(...args);
        await fs.writeFile(archivePath, "replaced after admission");
        return reader;
      });
      if (mode === "require") __setNativeLoaderForTest(() => ({ ...native!, openTarBufferNative: open }));
      await expect(readArchiveEntry(archivePath, "payload", { maxBytes: payload.length })).resolves.toEqual(payload);
      expect(staging).not.toHaveBeenCalled();
      if (mode === "require") expect(open).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("admits unselected members and framing before returning a range (gzip=%s)", async gzip => {
      configureFsSafeNative({ mode });
      const dir = await tempRoot("fs-safe-tar-buffer-invalid-");
      const archivePath = path.join(dir, gzip ? "input.tar.gz" : "input.tar");
      const checksum = Buffer.from(fixture); checksum[148]! ^= 1;
      for (const [bytes, code] of [
        [checksum, "archive-header-invalid"],
        [fixture.subarray(0, fixture.length - 512), "archive-header-invalid"],
        [Buffer.concat([fixture, Buffer.from([1])]), "archive-header-invalid"],
        [tarFixture([{ path: "payload", body: payload }, { path: "../escape" }]), "entry-path"],
        [tarFixture([{ path: "payload", body: payload }, { path: "./payload" }]), "entry-path"],
      ] as const) {
        await fs.writeFile(archivePath, gzip ? gzipSync(bytes) : bytes);
        await expect(readArchiveEntry(archivePath, "payload", { maxBytes: payload.length })).rejects.toMatchObject({ code });
      }
      await fs.writeFile(archivePath, gzip ? gzipSync(fixture) : fixture);
      await expect(readArchiveEntry(archivePath, "payload", { maxBytes: payload.length - 1 })).rejects.toMatchObject({ code: "archive-entry-extracted-size-exceeds-limit" });
    });
  });
}

describe.skipIf(!native)("native retained TAR reader", () => {
  it.each([false, true])("retains independent outputs during concurrent reads and cancellation (gzip=%s)", async gzip => {
    const input = own(gzip ? gzipSync(fixture) : fixture);
    const reader = await native!.openTarBufferNative(input, "tar", resolveTarMeterLimits());
    expect(reader.entries[1]).toMatchObject({ path: "payload", size: payload.length, index: 1 });
    const results = await Promise.all(Array.from({ length: 8 }, () => reader.readEntry(1, payload.length)));
    for (const result of results) expect(result).toEqual(payload);
    results[0]!.fill(0);
    expect(await reader.readEntry(1, payload.length)).toEqual(payload);
    expect(results[1]).toEqual(payload);
    await expect(reader.readEntry(3, payload.length)).rejects.toThrow("not found");
    await expect(reader.readEntry(2, payload.length)).rejects.toThrow("not a file");
    for (const max of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => reader.readEntry(1, max)).toThrow();
    const readAbort = new AbortController();
    const reading = reader.readEntry(1, payload.length, readAbort.signal);
    readAbort.abort();
    await expect(reading).rejects.toThrow();
    const openAbort = new AbortController();
    const opening = native!.openTarBufferNative(input, "tar", resolveTarMeterLimits(), openAbort.signal);
    openAbort.abort();
    await expect(opening).rejects.toThrow();
    await expect(native!.openTarBufferNative(input, "tar", { ...resolveTarMeterLimits(), maxDecodedBytes: fixture.length - 1 })).rejects.toThrow("archive-decoded-size-exceeds-limit");
  });
});

it("validates every physical gzip padding byte and joins cancellation", async () => {
  const input = Buffer.alloc(256 * 1024);
  await expect(validateGzipBufferTail(input, 1)).resolves.toBeUndefined();
  input[input.length - 1] = 1;
  await expect(validateGzipBufferTail(input, 1)).rejects.toThrow("nonzero gzip container padding");
  for (const consumed of [0, -1, NaN, 0.5, input.length + 1]) await expect(validateGzipBufferTail(input, consumed)).rejects.toThrow("consumed-input boundary");
  const abort = new AbortController();
  const pending = validateGzipBufferTail(input, 1, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow();
});
