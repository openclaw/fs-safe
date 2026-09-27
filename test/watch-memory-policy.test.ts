import { expect, it } from "vitest";
import { assessSoakMemory } from "../scripts/watch-stress/memory-policy.mjs";

const MiB = 1024 * 1024;
const samples = () => Array.from({ length: 60 }, (_, index) => ({ seconds: (index + 1) * 60,
  rss: (80 + Math.min(index, 25) * 5) * MiB, heapTotal: 140 * MiB,
  heapUsed: 9 * MiB, external: 3 * MiB, arrayBuffers: 0.2 * MiB }));

it("accepts RSS warm-up followed by a plateau while preserving the failed legacy result", () => {
  const result = assessSoakMemory(samples(), 220 * MiB);
  expect(result.failures).toEqual([]);
  expect(result.legacyRss.passed).toBe(false);
  expect(result.legacyRss.growth).toBe(100 * MiB);
});
it("rejects sustained RSS growth despite a flat collected heap", () => {
  const points = samples().map((sample, index) => ({ ...sample, rss: (80 + index * 2) * MiB }));
  expect(assessSoakMemory(points, 220 * MiB).failures).toContain("second-half RSS slope exceeded 1 MiB/minute");
});
it.each(["heapUsed", "external"])("rejects retained %s growth despite flat RSS", key => {
  const points = samples().map((sample, index) => ({ ...sample, [key]: (9 + index * 0.3) * MiB }));
  expect(assessSoakMemory(points, 220 * MiB).failures).toHaveLength(1);
});
it("keeps the peak ceiling and rejects incomplete or invalid evidence", () => {
  expect(assessSoakMemory(samples(), 512 * MiB).failures).toContain("soak peak RSS reached 512 MiB");
  expect(() => assessSoakMemory(samples().slice(1), 220 * MiB)).toThrow("every minute checkpoint");
  expect(() => assessSoakMemory(samples().map(sample => ({ ...sample, seconds: sample.seconds / 2 })), 220 * MiB)).toThrow("shortened");
  expect(() => assessSoakMemory(samples().map(sample => ({ ...sample, heapUsed: NaN })), 220 * MiB)).toThrow("invalid memory sample");
});
