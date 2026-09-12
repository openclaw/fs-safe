import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.each(["automatic", "Node 22.0 fallback"])("ZIP CRC32: %s", (backend) => {
  let update: typeof import("../src/archive-crc32.js").updateCrc32;

  beforeEach(async () => {
    vi.resetModules();
    if (backend !== "automatic") {
      vi.doMock("node:zlib", () => ({ default: { ...zlib, crc32: undefined } }));
    }
    update = (await import("../src/archive-crc32.js")).updateCrc32;
  });

  afterEach(() => vi.doUnmock("node:zlib"));

  it("matches standard vectors and preserves the seed for empty input", () => {
    expect(update(0, Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(update(0, Buffer.alloc(0))).toBe(0);
    expect(update(0xdeadbeef, Buffer.alloc(0))).toBe(0xdeadbeef);
    expect(update(-1, Buffer.alloc(0))).toBe(0xffffffff);
  });

  it("chains arbitrary chunks, including empty chunks and nonzero buffer offsets", () => {
    const storage = Buffer.alloc(256 * 1024 + 7);
    for (let i = 0; i < storage.length; i++) storage[i] = (i * 31 + (i >>> 8)) & 0xff;
    const input = storage.subarray(3, storage.length - 4);
    for (const [seed, expected] of [[0, 0xb22274f8], [1, 0x4d2a9117], [0xffffffff, 0xafd36125]]) {
      let actual = seed;
      for (let start = 0; start < input.length; start += 1009) {
        actual = update(actual, input.subarray(start, start + 1009));
        actual = update(actual, Buffer.alloc(0));
      }
      expect(actual).toBe(expected);
      expect(update(seed, input)).toBe(actual);
    }
  });
});
