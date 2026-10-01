import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { trend } from "./metrics.mjs";

const SOAK_MINUTES = 60;
const RSS_SLOPE_MINUTES = 30;
const MiB = 1024 * 1024;

export async function collectedMemory() {
  assert.equal(typeof global.gc, "function", "soak memory checks require --expose-gc");
  const beforeGc = process.memoryUsage();
  global.gc(); await immediate(); global.gc();
  return { beforeGc, ...process.memoryUsage() };
}

export function assessSoakMemory(samples, peakRss, minutes = SOAK_MINUTES) {
  assert.ok(Number.isSafeInteger(minutes) && minutes >= 10, "soak requires at least ten minutes");
  assert.equal(samples.length, minutes, "soak requires every minute checkpoint");
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
  const secondHalfRss = trend(samples.slice(Math.floor(minutes / 2)));
  const rssSlopeGated = minutes >= RSS_SLOPE_MINUTES;
  const limits = { peakRss: 512 * MiB, heapUsedGrowth: 8 * MiB, externalGrowth: 8 * MiB,
    rssBytesPerSecond: MiB / 60 };
  const heapUsedGrowth = growth("heapUsed"), externalGrowth = growth("external");
  const failures = [];
  if (peakRss >= limits.peakRss) failures.push("soak peak RSS reached 512 MiB");
  if (heapUsedGrowth > limits.heapUsedGrowth) failures.push("collected heap grew by more than 8 MiB");
  if (externalGrowth > limits.externalGrowth) failures.push("external memory grew by more than 8 MiB");
  // Short runs can still be warming V8 capacity; always report the same slope
  // and limit, but enforce it only once the run spans at least 30 minutes.
  if (rssSlopeGated && secondHalfRss.bytesPerSecond > limits.rssBytesPerSecond) failures.push("second-half RSS slope exceeded 1 MiB/minute");
  return { minutes, qualification: minutes >= SOAK_MINUTES, rssSlopeGated, limits, heapUsedGrowth, externalGrowth, secondHalfRss,
    legacyRss: { ...legacy, limit: 64 * MiB, passed: legacy.growth <= 64 * MiB }, failures };
}
