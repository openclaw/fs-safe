import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { trend } from "./metrics.mjs";

export const SOAK_MINUTES = 60;
const MiB = 1024 * 1024;

export async function collectedMemory() {
  assert.equal(typeof global.gc, "function", "soak memory checks require --expose-gc");
  const beforeGc = process.memoryUsage();
  global.gc(); await immediate(); global.gc();
  return { beforeGc, ...process.memoryUsage() };
}

export function assessSoakMemory(samples, peakRss) {
  assert.equal(samples.length, SOAK_MINUTES, "soak requires every minute checkpoint");
  for (const [index, sample] of samples.entries()) {
    for (const key of ["seconds", "rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]) {
      assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0, `invalid memory sample: ${key}`);
    }
    assert.ok(sample.seconds >= (index + 1) * 60, "shortened soak checkpoint");
    if (index) assert.ok(sample.seconds > samples[index - 1].seconds, "unordered soak checkpoints");
  }
  assert.ok(Number.isFinite(peakRss) && peakRss > 0, "missing peak RSS");
  const settled = samples.slice(5);
  const growth = key => Math.max(...settled.map(sample => sample[key])) - settled[0][key];
  const legacy = trend(settled);
  const secondHalfRss = trend(samples.slice(SOAK_MINUTES / 2));
  const limits = { peakRss: 512 * MiB, heapUsedGrowth: 8 * MiB, externalGrowth: 8 * MiB,
    rssBytesPerSecond: MiB / 60 };
  const heapUsedGrowth = growth("heapUsed"), externalGrowth = growth("external");
  const failures = [];
  if (peakRss >= limits.peakRss) failures.push("soak peak RSS reached 512 MiB");
  if (heapUsedGrowth > limits.heapUsedGrowth) failures.push("collected heap grew by more than 8 MiB");
  if (externalGrowth > limits.externalGrowth) failures.push("external memory grew by more than 8 MiB");
  if (secondHalfRss.bytesPerSecond > limits.rssBytesPerSecond) failures.push("second-half RSS slope exceeded 1 MiB/minute");
  return { limits, heapUsedGrowth, externalGrowth, secondHalfRss,
    legacyRss: { ...legacy, limit: 64 * MiB, passed: legacy.growth <= 64 * MiB }, failures };
}
