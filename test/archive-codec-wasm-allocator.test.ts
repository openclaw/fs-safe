import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { allocatorTestArtifact } from "../scripts/archive-wasm-build-tools.mjs";
import { codecAbi, codecDecode, codecError, lowMemoryIntact, parserPush, type CodecAbi } from "./helpers/archive-codec-abi.js";
import { archiveCodecFixtures, codecSmallTar } from "./helpers/archive-codec-fixtures.js";

function loadModule(): WebAssembly.Module {
  try { return new WebAssembly.Module(readFileSync(allocatorTestArtifact(process.env))); }
  catch (cause) { throw new Error("Build allocator proof first with pnpm archive:wasm:allocator-tests", { cause }); }
}
const module = loadModule();
type AllocatorAbi = CodecAbi & {
  test_allocator_limit(remaining: number): void;
  test_allocator_live(): number;
  test_allocator_attempts(): number;
  test_allocator_probe(size: number): number;
};
function instance(): AllocatorAbi { return codecAbi(module) as AllocatorAbi; }

for (const fixture of archiveCodecFixtures) {
  for (const admitted of [0, 1, 2]) {
    it(`${fixture.kind} releases failed allocation ${admitted} and preserves live parser/peer state`, () => {
      const abi = instance();
      const peer = instance();
      for (const current of [abi, peer]) {
        expect(current.init(10, 1024, 20000, 4096, 0)).toBe(0);
        parserPush(current, codecSmallTar().subarray(0, 512));
      }
      expect(peer.codec_init(fixture.id)).toBe(0);
      abi.test_allocator_limit(admitted);
      const initialized = abi.codec_init(fixture.id);
      if (initialized === 0) {
        const prefix = fixture.id === 2 && admitted === 2
          ? Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38, 0x03, 0x00, 0x10, 0x00])
          : Buffer.alloc(0);
        expect(() => codecDecode(abi, Buffer.concat([prefix, Buffer.from(fixture.large, "base64")]))).toThrow(/allocation|memory/i);
      } else {
        expect(codecError(abi)).toMatch(/allocation|memory/i);
      }
      expect(abi.test_allocator_attempts()).toBe(admitted + 1);
      expect(abi.test_allocator_live()).toBe(0);
      expect(abi.codec_push(0)).toBe(-1);
      expect(abi.codec_finish()).toBe(-1);
      for (const current of [abi, peer]) {
        parserPush(current, codecSmallTar().subarray(512));
        expect(current.finish()).toBe(0);
        lowMemoryIntact(current);
      }
      expect(codecDecode(peer, Buffer.from(fixture.small, "base64")).bytes.equals(codecSmallTar())).toBe(true);
      expect(peer.test_allocator_live()).toBe(0);
      abi.test_allocator_limit(-1);
      expect(abi.codec_init(fixture.id)).toBe(0);
      expect(codecDecode(abi, Buffer.from(fixture.small, "base64")).bytes.equals(codecSmallTar())).toBe(true);
      expect(abi.test_allocator_live()).toBe(0);
    });
  }
  it(`${fixture.kind} frees partially decoded, corrupt, replaced, and disposed sessions`, () => {
    const abi = instance();
    const encoded = Buffer.from(fixture.small, "base64");
    for (let repeat = 0; repeat < 20; repeat++) {
      expect(abi.codec_init(fixture.id)).toBe(0);
      new Uint8Array(abi.memory.buffer, abi.codec_input_ptr(), 10).set(encoded.subarray(0, 10));
      expect(abi.codec_push(10)).toBeGreaterThanOrEqual(0);
      expect(abi.test_allocator_live()).toBeGreaterThan(0);
      expect(abi.codec_init(fixture.id)).toBe(0);
      expect(() => codecDecode(abi, encoded.subarray(0, -1))).toThrow();
      expect(abi.test_allocator_live()).toBe(0);
      expect(abi.codec_init(fixture.id)).toBe(0);
      abi.codec_dispose();
      abi.codec_dispose();
      expect(abi.test_allocator_live()).toBe(0);
      lowMemoryIntact(abi);
    }
  });
}

it("checks real allocation/free, alignment-sized storage, OOM and overflow under the production optimization profile", () => {
  for (const size of [0, 1, 16, 1000, 268435456, 0xfffffff0, 0xffffffff]) {
    const abi = instance();
    expect(abi.test_allocator_probe(size)).toBe(size < 268435456 ? 0 : -1);
    expect(abi.test_allocator_live()).toBe(0);
    expect(abi.test_allocator_attempts()).toBe(1);
    lowMemoryIntact(abi);
    expect(abi.codec_init(2)).toBe(0);
    expect(codecDecode(abi, Buffer.from(archiveCodecFixtures[1].small, "base64")).bytes.equals(codecSmallTar())).toBe(true);
    expect(abi.test_allocator_live()).toBe(0);
  }
});
