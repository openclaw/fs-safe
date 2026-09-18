import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { codecAbi, codecDecode, codecError, lowMemoryIntact, parserPush, skippableFrame } from "./helpers/archive-codec-abi.js";
import { archiveCodecFixtures, codecLargeTar, codecSmallTar } from "./helpers/archive-codec-fixtures.js";

const module = new WebAssembly.Module(readFileSync(new URL("../dist/archive-parser.wasm", import.meta.url)));

it("keeps production imports and allocator mutation hooks absent and validates the codec ABI", () => {
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(WebAssembly.Module.exports(module).filter(entry => entry.name.startsWith("test_"))).toEqual([]);
  const abi = codecAbi(module);
  expect(abi.codec_push(0)).toBe(-1);
  expect(abi.codec_finish()).toBe(-1);
  for (const kind of [0, 3, -1, 0x7fffffff]) expect(abi.codec_init(kind)).toBe(-1);
  for (const length of [-1, 65537, 0x7fffffff]) {
    expect(abi.codec_init(2)).toBe(0);
    expect(abi.codec_push(length)).toBe(-1);
    expect(abi.codec_consumed()).toBe(0);
    expect(abi.codec_produced()).toBe(0);
    expect(abi.codec_finish()).toBe(-1);
  }
  abi.codec_dispose();
  abi.codec_dispose();
  expect(abi.codec_push(0)).toBe(-1);
  expect(abi.codec_input_ptr() + 65536).toBeLessThanOrEqual(abi.memory.buffer.byteLength);
  expect(abi.codec_output_ptr() + 65536).toBeLessThanOrEqual(abi.memory.buffer.byteLength);
  abi.memory.grow(4096 - abi.memory.buffer.byteLength / 65536);
  expect(() => abi.memory.grow(1)).toThrow();
});

for (const fixture of archiveCodecFixtures) {
  for (const chunkSize of [1, 7, 65536]) {
    it(`${fixture.kind} decodes checksummed members at ${chunkSize}-byte input boundaries`, () => {
      const abi = codecAbi(module);
      expect(abi.codec_init(fixture.id)).toBe(0);
      expect(codecDecode(abi, Buffer.from(fixture.small, "base64"), chunkSize).bytes.equals(codecSmallTar())).toBe(true);
      expect(abi.codec_push(0)).toBe(-1);
      expect(abi.codec_finish()).toBe(-1);
      lowMemoryIntact(abi);
    });
  }
  it(`${fixture.kind} validates concatenated members and interleaves the same-instance TAR parser`, () => {
    const abi = codecAbi(module);
    for (const split of [1, 511, 512, 513] as const) {
      const bytes = Buffer.concat([
        Buffer.from(fixture[`prefix${split}`], "base64"), Buffer.from(fixture.empty, "base64"),
        Buffer.from(fixture[`rest${split}`], "base64"), Buffer.from(fixture.empty, "base64"),
      ]);
      expect(abi.init(10, 1024, 20000, 4096, 0)).toBe(0);
      expect(abi.codec_init(fixture.id)).toBe(0);
      const names: string[] = [];
      expect(codecDecode(abi, bytes, 7, chunk => names.push(...parserPush(abi, chunk))).bytes.equals(codecSmallTar())).toBe(true);
      expect(names).toEqual(["value.txt"]);
      expect(abi.finish()).toBe(0);
    }
  });
  it(`${fixture.kind} drains buffered output and handles compressed inputs crossing the inbox`, () => {
    const abi = codecAbi(module);
    expect(abi.codec_init(fixture.id)).toBe(0);
    const expanded = codecDecode(abi, Buffer.from(fixture.large, "base64"));
    expect(expanded.bytes.equals(codecLargeTar())).toBe(true);
    expect(expanded.emptyInputOutputCalls).toBeGreaterThan(0);
    const empty = Buffer.from(fixture.empty, "base64");
    const bytes = Buffer.concat([...Array<Buffer>(6000).fill(empty), Buffer.from(fixture.small, "base64")]);
    expect(bytes.length).toBeGreaterThan(65536);
    expect(abi.codec_init(fixture.id)).toBe(0);
    expect(codecDecode(abi, bytes).bytes.equals(codecSmallTar())).toBe(true);
    lowMemoryIntact(abi);
  });
  it(`${fixture.kind} rejects incomplete or corrupt physical tails after a complete TAR`, () => {
    const complete = Buffer.from(fixture.small, "base64");
    const corrupted = Buffer.from(complete);
    corrupted[fixture.id === 1 ? 10 : corrupted.length - 1]! ^= 0x80;
    const corruptEmpty = Buffer.from(fixture.empty, "base64");
    corruptEmpty[corruptEmpty.length - 2]! ^= 0x80;
    const tails = [Buffer.alloc(20), Buffer.from("junk"), complete.subarray(0, 1), complete.subarray(0, 10), complete.subarray(0, -1), corrupted, corruptEmpty];
    for (const bytes of [complete.subarray(0, -1), corrupted, ...tails.map(tail => Buffer.concat([complete, tail]))]) {
      const abi = codecAbi(module);
      expect(abi.codec_init(fixture.id)).toBe(0);
      expect(() => codecDecode(abi, bytes, 7)).toThrow();
      expect(codecError(abi)).not.toBe("");
      expect(abi.codec_push(0)).toBe(-1);
      abi.codec_dispose();
      expect(abi.codec_init(fixture.id)).toBe(0);
      expect(codecDecode(abi, complete).bytes.equals(codecSmallTar())).toBe(true);
      lowMemoryIntact(abi);
    }
  });
  it(`${fixture.kind} fails real allocator growth without corrupting live parser or peer state`, () => {
    const abi = codecAbi(module);
    const peer = codecAbi(module);
    for (const instance of [abi, peer]) {
      expect(instance.init(10, 1024, 20000, 4096, 0)).toBe(0);
      expect(parserPush(instance, codecSmallTar().subarray(0, 512))).toEqual(["value.txt"]);
      expect(instance.codec_init(fixture.id)).toBe(0);
    }
    abi.memory.grow(4096 - abi.memory.buffer.byteLength / 65536);
    expect(() => codecDecode(abi, Buffer.from(fixture.large, "base64"))).toThrow(/allocation|memory/i);
    for (const instance of [abi, peer]) {
      parserPush(instance, codecSmallTar().subarray(512));
      expect(instance.finish()).toBe(0);
      lowMemoryIntact(instance);
    }
    expect(codecDecode(peer, Buffer.from(fixture.small, "base64")).bytes.equals(codecSmallTar())).toBe(true);
    expect(abi.codec_init(fixture.id)).toBe(0);
    if (fixture.id === 1) {
      // Bzip2 allocates its block table before recognizing an empty member.
      expect(() => codecDecode(abi, Buffer.from(fixture.empty, "base64"))).toThrow(/allocation|memory/i);
    } else {
      expect(codecDecode(abi, Buffer.from(fixture.empty, "base64")).bytes).toHaveLength(0);
    }
    const next = codecAbi(module);
    expect(next.codec_init(fixture.id)).toBe(0);
    expect(codecDecode(next, Buffer.from(fixture.small, "base64")).bytes.equals(codecSmallTar())).toBe(true);
  });
}

it("zstd preserves skippable-frame and dictionary-required behavior across members", () => {
  const fixture = archiveCodecFixtures[1];
  const complete = Buffer.from(fixture.small, "base64");
  const skipped = skippableFrame(Buffer.alloc(65537, 0xa5));
  const abi = codecAbi(module);
  expect(abi.codec_init(2)).toBe(0);
  const bytes = Buffer.concat([skipped, complete, skipped, Buffer.from(fixture.empty, "base64"), skipped]);
  expect(codecDecode(abi, bytes, 7).bytes.equals(codecSmallTar())).toBe(true);
  const header = Buffer.from(complete);
  expect(header[4]! & 3).toBe(0);
  const dictionaryOffset = header[4]! & 0x20 ? 5 : 6;
  header[4]! |= 1;
  const dictionary = Buffer.concat([header.subarray(0, dictionaryOffset), Buffer.from([7]), header.subarray(dictionaryOffset)]);
  for (const tail of [skipped.subarray(0, 1), skipped.subarray(0, 7), skipped.subarray(0, 8), skipped.subarray(0, -1), dictionary]) {
    expect(abi.codec_init(2)).toBe(0);
    expect(() => codecDecode(abi, Buffer.concat([complete, tail]))).toThrow();
    lowMemoryIntact(abi);
  }
});
