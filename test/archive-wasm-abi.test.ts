import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { unifiedFixture } from "./helpers/archive-unified.js";

const module = new WebAssembly.Module(readFileSync(new URL("../dist/archive-parser.wasm", import.meta.url)));
function parser() {
  return new WebAssembly.Instance(module).exports as unknown as {
    memory: WebAssembly.Memory; input_ptr(): number; init(a: number, b: number, c: number, d: number, windows: number): number;
    push(length: number): number; finish(): number; dispose(): void; text_ptr(): number; text_len(): number;
    member_type(): number;
  };
}
function text(p: ReturnType<typeof parser>) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(new Uint8Array(p.memory.buffer, p.text_ptr(), p.text_len()));
}
it("has no imports, rejects invalid limits and inbox lengths, and bounds linear memory", () => {
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const p = parser();
  for (const value of [NaN, Infinity, -1]) expect(p.init(value, 1024, 10000, 4096, 0)).toBe(-1);
  expect(p.push(1)).toBe(-1);
  expect(p.init(10, 1024, 10000, 4096, 0)).toBe(0);
  for (const length of [0, 65537, -1, 0x7fffffff]) expect(p.push(length)).toBe(-1);
  expect(p.input_ptr() + 65536).toBeLessThanOrEqual(p.memory.buffer.byteLength);
  expect(() => p.memory.grow(4096)).toThrow();
  p.dispose();
  expect(p.push(1)).toBe(-1);
  expect(p.finish()).toBe(-1);
});
it("keeps concurrent parser states isolated and consumes one bounded event at a time", () => {
  const parsers = [parser(), parser()];
  const names = ["雪.txt", "line\n.txt"];
  const bytes = names.map((name) => unifiedFixture(name).bytes);
  const offsets = [0, 0];
  const observed: string[][] = [[], []];
  for (const p of parsers) expect(p.init(10, 1024, 20000, 4096, 0)).toBe(0);
  while (offsets.some((offset, i) => offset < bytes[i]!.length)) {
    parsers.forEach((p, i) => {
      const offset = offsets[i]!;
      if (offset === bytes[i]!.length) return;
      const chunk = bytes[i]!.subarray(offset, offset + 7);
      new Uint8Array(p.memory.buffer, p.input_ptr(), chunk.length).set(chunk);
      const used = p.push(chunk.length);
      expect(used).toBeGreaterThan(0);
      expect(used).toBeLessThanOrEqual(chunk.length);
      offsets[i]! += used;
      if (p.member_type() >= 0) observed[i]!.push(text(p));
    });
  }
  expect(observed).toEqual(names.map((name) => [name, "sentinel"]));
  for (const p of parsers) { expect(p.finish()).toBe(0); p.dispose(); }
});
it("fails metadata allocation within the memory ceiling without accepting its body", () => {
  const p = parser();
  const size = 300 * 1024 * 1024;
  expect(p.init(10, size, size + 1024, 4096, 0)).toBe(0);
  const header = tarFixture([{ path: "PaxHeader", type: "x", mutateHeader(block) {
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  } }], false).subarray(0, 512);
  new Uint8Array(p.memory.buffer, p.input_ptr(), 512).set(header);
  expect(p.push(512)).toBe(-1);
  expect(text(p)).toContain("archive-meta-entry-size-exceeds-limit");
  expect(p.push(1)).toBe(-1);
  p.dispose();
});

it("applies the host Windows path policy to raw names even when overridden", () => {
  const fixture = unifiedFixture("safe").bytes;
  // The effective name stays safe; the member's raw header carries an ADS spelling.
  const rawOffset = 1024;
  fixture.fill(0, rawOffset, rawOffset + 100);
  fixture.write("file:stream", rawOffset);
  fixture.fill(32, rawOffset + 148, rawOffset + 156);
  const sum = fixture.subarray(rawOffset, rawOffset + 512).reduce((a, b) => a + b, 0);
  fixture.write(`${sum.toString(8).padStart(6, "0")}\0 `, rawOffset + 148);
  for (const windows of [0, 1]) {
    const p = parser();
    expect(p.init(10, 1024, 10000, 4096, windows)).toBe(0);
    let offset = 0;
    while (offset < fixture.length) {
      const bytes = fixture.subarray(offset, offset + 512);
      new Uint8Array(p.memory.buffer, p.input_ptr(), bytes.length).set(bytes);
      const used = p.push(bytes.length);
      if (used < 0) break;
      offset += used;
    }
    if (windows) { expect(offset).toBe(rawOffset); expect(text(p)).toContain("archive-entry-path-invalid"); }
    else { expect(offset).toBe(fixture.length); expect(p.finish()).toBe(0); }
    p.dispose();
  }
});
