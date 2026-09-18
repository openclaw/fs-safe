import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createPortableTarDecoder, type PortableTarCodec } from "../src/archive-codec-wasm.js";

// Synthetic fixtures from Python bz2 and Node zstd (checksum enabled), retained
// so every supported Node version tests the portable decoder without compressors.
const fixtures = {
  "tar-bzip2": {
    large: "QlpoOTFBWSZTWYZ+qZIBEW/RgAAQQAA2BNQgMAC4CBoGgQNA0ApVDRpkYCFR2EKjYQqPQhUaCFRkEKjQQqNBCo+CFRyEKjAQqNhCo2EKjIQqPghUehCo/F3JFOFCQhn6pkg=",
    left: "QlpoOTFBWSZTWboZAWMAAAEBgAMEBAAgACGaaDNNMLxdyRThQkLoZAWM",
    right: "QlpoOTFBWSZTWeLd1ysAAAGBgADgFAAgACGDQZoLMHF3JFOFCQ4t3XKw",
    empty: "QlpoORdyRThQkAAAAAA=",
  },
  "tar-zstd": {
    large: "KLUv/aQQmAIAzAAAiHBvcnRhYmxlIHBheWxvYWQKAQDZ/ymfS00AAAhyAQAMGB0IAYpnMaw=",
    left: "KLUv/SQEIQAAbGVmdMib5kg=",
    right: "KLUv/SQFKQAAcmlnaHSSPrO+",
    empty: "KLUv/SQAAQAAmenYUQ==",
  },
} as const;
const payload = Buffer.from("portable payload\n".repeat(10000));

async function decode(kind: PortableTarCodec, bytes: Buffer, options: { chunk?: number; limit?: number; signal?: AbortSignal } = {}) {
  const chunks: Buffer[] = [];
  const input = Readable.from((function* () {
    for (let offset = 0; offset < bytes.length; offset += options.chunk ?? 65536) {
      yield bytes.subarray(offset, offset + (options.chunk ?? 65536));
    }
  })());
  await pipeline(input, createPortableTarDecoder(kind, options.limit ?? 1_000_000, options.signal),
    new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } }));
  return chunks;
}

describe.each(["tar-bzip2", "tar-zstd"] as const)("portable %s containers", (kind) => {
  const fixture = fixtures[kind];
  const large = Buffer.from(fixture.large, "base64");
  const left = Buffer.from(fixture.left, "base64");
  const right = Buffer.from(fixture.right, "base64");

  it.each([1, 7, 65536])("owns bounded output under %i-byte input splits", async (chunk) => {
    const chunks = await decode(kind, large, { chunk, limit: payload.length });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((bytes) => bytes.length <= 65536)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(payload);
    // Later output must not overwrite retained earlier windows.
    expect(chunks[0]!.subarray(0, 17).toString()).toBe("portable payload\n");
  });

  it("decodes concatenated members and empty members through physical EOF", async () => {
    const bytes = Buffer.concat([Buffer.from(fixture.empty, "base64"), left, right, Buffer.from(fixture.empty, "base64")]);
    expect(Buffer.concat(await decode(kind, bytes, { chunk: 1 }))).toEqual(Buffer.from("leftright"));
    expect(await decode(kind, Buffer.from(fixture.empty, "base64"), { limit: 0 })).toEqual([]);
  });

  it.each([0, 1, payload.length - 1])("enforces decoded ceiling %i before returning excess output", async (limit) => {
    await expect(decode(kind, large, { limit })).rejects.toMatchObject({ code: "archive-decoded-size-exceeds-limit" });
  });

  it.each([
    ["empty input", Buffer.alloc(0)],
    ["truncated header", large.subarray(0, 3)],
    ["truncated body", large.subarray(0, large.length >> 1)],
    ["truncated trailer", large.subarray(0, large.length - 1)],
    ["trailing garbage", Buffer.concat([large, Buffer.from("garbage")])],
    ["truncated next member", Buffer.concat([left, right.subarray(0, right.length - 1)])],
    ["bad checksum", (() => { const bytes = Buffer.from(large); bytes[bytes.length - 2]! ^= 1; return bytes; })()],
  ] as const)("rejects %s", async (_name, bytes) => {
    await expect(decode(kind, bytes, { chunk: 7 })).rejects.toMatchObject({ code: "archive-header-invalid" });
  });

  it("cancels buffered decoding and joins the input iterator", async () => {
    const controller = new AbortController();
    let closed = false;
    let outputs = 0;
    const input = Readable.from((async function* () {
      try {
        yield large;
        await setImmediate();
        yield large;
      } finally { closed = true; }
    })());
    const operation = pipeline(input, createPortableTarDecoder(kind, 1_000_000, controller.signal),
      new Writable({ write(_chunk, _encoding, done) { outputs++; controller.abort(); done(); } }));
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(outputs).toBe(1);
    expect(closed).toBe(true);
  });
});

function rawZstd(bytes: Buffer, declared = bytes.length): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0xfd2fb528, 0);
  header[4] = 0xa0; // Single segment, four-byte content size, no checksum.
  header.writeUInt32LE(declared, 5);
  header.writeUIntLE((bytes.length << 3) | 1, 9, 3);
  return Buffer.concat([header, bytes]);
}

it("supports zstd raw and RLE blocks, skippable frames, and concatenated frames", async () => {
  const skip = Buffer.from([0x5f, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 8, 7]);
  const rle = rawZstd(Buffer.from("x"), 17);
  rle.writeUIntLE((17 << 3) | 3, 9, 3);
  const bytes = Buffer.concat([skip, rawZstd(Buffer.from("left")), skip, rle, skip]);
  expect(Buffer.concat(await decode("tar-zstd", bytes, { chunk: 1 }))).toEqual(Buffer.from(`left${"x".repeat(17)}`));
  await expect(decode("tar-zstd", bytes.subarray(0, bytes.length - 1))).rejects.toMatchObject({ code: "archive-header-invalid" });
});

it.each([0, 3, 5])("checks zstd declared content size %i", async (declared) => {
  await expect(decode("tar-zstd", rawZstd(Buffer.from("left"), declared)))
    .rejects.toMatchObject({ code: "archive-header-invalid" });
});

it("rejects excessive zstd windows and oversized blocks before allocation", async () => {
  const window = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xf8, 1, 0, 0]);
  await expect(decode("tar-zstd", window)).rejects.toMatchObject({ code: "archive-header-invalid" });
  const block = rawZstd(Buffer.from("x"));
  block.writeUIntLE(((128 * 1024 + 1) << 3) | 1, 9, 3);
  await expect(decode("tar-zstd", block)).rejects.toMatchObject({ code: "archive-header-invalid" });
});

it("rejects reserved zstd frame descriptors and blocks exceeding the frame window", async () => {
  const reserved = rawZstd(Buffer.from("left"));
  reserved[4]! |= 8;
  await expect(decode("tar-zstd", reserved)).rejects.toMatchObject({ code: "archive-header-invalid" });
  // Multi-segment frame with no declared size and the minimum 1 KiB window.
  const oversized = Buffer.alloc(9 + 1025);
  oversized.writeUInt32LE(0xfd2fb528, 0);
  oversized.writeUIntLE((1025 << 3) | 1, 6, 3);
  await expect(decode("tar-zstd", oversized)).rejects.toMatchObject({ code: "archive-header-invalid" });
});

it("rejects invalid codec ABI ranges and disposes isolated decoder states", () => {
  const module = new WebAssembly.Module(readFileSync(new URL("../dist/archive-parser.wasm", import.meta.url)));
  type Abi = { codec_init(kind: number, limit: number): number; codec_step(offset: number, length: number, eof: number): number; codec_dispose(): void };
  const codecs = [1, 2].map(() => new WebAssembly.Instance(module).exports as unknown as Abi);
  for (const [index, codec] of codecs.entries()) {
    for (const limit of [-1, NaN, Infinity]) expect(codec.codec_init(index + 1, limit)).toBe(-1);
    expect(codec.codec_init(3, 100)).toBe(-1);
    expect(codec.codec_init(index + 1, 100)).toBe(0);
    for (const [offset, length, eof] of [[-1, 1, 0], [65536, 1, 0], [1, 65536, 0], [0, 65537, 0], [0, 0, 2]]) {
      expect(codec.codec_step(offset!, length!, eof!)).toBe(-1);
    }
    codec.codec_dispose();
    expect(codec.codec_step(0, 0, 1)).toBe(-1);
  }
});
