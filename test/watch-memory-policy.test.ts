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
it.each([30, 60])("gates sustained RSS growth for a %i-minute soak despite flat collected heap", minutes => {
  const points = samples().slice(0, minutes).map((sample, index) => ({ ...sample, rss: (80 + index * 2) * MiB }));
  const result = assessSoakMemory(points, 220 * MiB, minutes);
  expect(result.rssSlopeGated).toBe(true);
  expect(result.failures).toContain("second-half RSS slope exceeded 1 MiB/minute");
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

it("evaluates a configured short soak without claiming hour-long qualification", () => {
  const points = samples().slice(0, 10).map(sample => ({ ...sample, rss: 80 * MiB }));
  const result = assessSoakMemory(points, 100 * MiB, 10);
  expect(result.failures).toEqual([]);
  expect(result.qualification).toBe(false);
  expect(assessSoakMemory(samples(), 220 * MiB).qualification).toBe(true);
  expect(() => assessSoakMemory(points.slice(1), 100 * MiB, 10)).toThrow("every minute checkpoint");
  expect(() => assessSoakMemory(points, 100 * MiB, 9)).toThrow("at least ten minutes");
});

it.each([10, 29])("reports an over-limit RSS slope without gating a %i-minute soak", minutes => {
  const points = samples().slice(0, minutes).map((sample, index) => ({ ...sample, rss: (80 + index * 2) * MiB }));
  const report = JSON.parse(JSON.stringify(assessSoakMemory(points, 220 * MiB, minutes)));
  expect(report.failures).toEqual([]);
  expect(report.rssSlopeGated).toBe(false);
  expect(report.qualification).toBe(false);
  expect(report.limits.rssBytesPerSecond).toBe(MiB / 60);
  expect(report.secondHalfRss.bytesPerSecond).toBeGreaterThan(report.limits.rssBytesPerSecond);
});

it.each(["heapUsed", "external"])("still gates short-soak %s growth", key => {
  const points = samples().slice(0, 10).map((sample, index) => ({ ...sample,
    rss: 100 * MiB, [key]: (9 + index * 3) * MiB,
  }));
  const result = assessSoakMemory(points, 100 * MiB, 10);
  expect(result.failures).toEqual([key === "heapUsed"
    ? "collected heap grew by more than 8 MiB" : "external memory grew by more than 8 MiB"]);
});

it("still gates short-soak peak RSS", () => {
  const points = samples().slice(0, 10);
  expect(assessSoakMemory(points, 512 * MiB, 10).failures).toEqual(["soak peak RSS reached 512 MiB"]);
});
