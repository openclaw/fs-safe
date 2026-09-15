import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File, sha256FileSync } from "../src/file-hash.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

describe.each(["async", "sync"] as const)("SHA-256 scratch allocation (%s)", mode => {
  async function fixture(size: number) {
    const directory = await tempRoot("fs-safe-hash-allocation-");
    const file = path.join(directory, "input");
    const contents = Buffer.alloc(size, 0x71);
    if (size >= 3) contents.set([0x31, 0x32, 0x33]);
    await fs.writeFile(file, contents);
    configureFsSafeNative({ mode: "off" });
    return { handle: await fs.open(file, "r"), contents };
  }

  it.each([0, 1, 512, 4096])("sizes a small-file scratch buffer to %s bytes plus its EOF probe", async size => {
    const { handle, contents } = await fixture(size);
    const read = mode === "async" ? vi.spyOn(handle, "read") : vi.spyOn(fsSync, "readSync");
    try {
      const result = mode === "async" ? await sha256File(handle) : sha256FileSync(handle.fd);
      expect(result).toEqual({ bytes: size, digest: createHash("sha256").update(contents).digest("hex") });
      const bufferIndex = mode === "async" ? 0 : 1;
      for (const call of read.mock.calls) expect((call[bufferIndex] as Buffer).length).toBeLessThanOrEqual(size + 1);
      expect(read).toHaveBeenCalledTimes(size === 0 ? 1 : 2);
    } finally {
      await handle.close();
    }
  });

  it.each([0, 1, 512])("grows an undersized %s-byte hint without dropping bytes or advancing the borrowed cursor", async sizeHint => {
    const { handle, contents } = await fixture(256 * 1024);
    await handle.read(Buffer.alloc(2), 0, 2, null);
    const stat = fsSync.fstatSync(handle.fd);
    vi.spyOn(fsSync, "fstatSync").mockReturnValue(Object.assign(Object.create(stat), { size: sizeHint }));
    const read = mode === "async" ? vi.spyOn(handle, "read") : vi.spyOn(fsSync, "readSync");
    try {
      const result = mode === "async" ? await sha256File(handle) : sha256FileSync(handle.fd);
      expect(result).toEqual({ bytes: contents.length, digest: createHash("sha256").update(contents).digest("hex") });
      expect(read.mock.calls.length).toBeLessThanOrEqual(6);
      const bufferIndex = mode === "async" ? 0 : 1;
      expect((read.mock.calls[0]![bufferIndex] as Buffer).length).toBe(sizeHint + 1);
      expect((read.mock.calls[1]![bufferIndex] as Buffer).length).toBe(64 * 1024);
      const next = Buffer.alloc(1);
      expect((await handle.read(next, 0, 1, null)).bytesRead).toBe(1);
      expect(next[0]).toBe(contents[2]);
    } finally {
      await handle.close();
    }
  });

  it("limits growth from a zero-size hint to the byte budget plus one", async () => {
    const { handle } = await fixture(1024);
    const stat = fsSync.fstatSync(handle.fd);
    vi.spyOn(fsSync, "fstatSync").mockReturnValue(Object.assign(Object.create(stat), { size: 0 }));
    const read = mode === "async" ? vi.spyOn(handle, "read") : vi.spyOn(fsSync, "readSync");
    try {
      await expect(async () => mode === "async"
        ? await sha256File(handle, { maxBytes: 4 })
        : sha256FileSync(handle.fd, { maxBytes: 4 })).rejects.toMatchObject({ code: "too-large" });
      const lengthIndex = mode === "async" ? 2 : 3;
      expect(read.mock.calls.map(call => call[lengthIndex])).toEqual([1, 4]);
      const bufferIndex = mode === "async" ? 0 : 1;
      for (const call of read.mock.calls) expect((call[bufferIndex] as Buffer).length).toBeLessThanOrEqual(5);
    } finally {
      await handle.close();
    }
  });
});
