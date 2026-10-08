import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { formatErrorDetail } from "../dist/error-detail.js";
import { formatPermissionErrorDetail } from "../dist/permission-exec.js";

// Historical baseline; both routes use the same escaping implementation.
function baseline(value) {
  const formatted = formatErrorDetail(value);
  return formatted.length > 400 ? `${formatted.slice(0, 399)}…` : formatted;
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let checksum = 0;
function measure(fn, value, iterations) {
  const start = performance.now();
  for (let index = 0; index < iterations; index++) checksum += fn(value).length;
  return (performance.now() - start) * 1e6 / iterations;
}
const results = [];
for (const [name, value, iterations] of [
  ["short", "permission denied", 20000],
  ["1 MiB plain", "x".repeat(1024 * 1024), 30],
  ["64 KiB controls", "\u0000".repeat(65536), 5],
]) {
  assert.equal(formatPermissionErrorDetail(value), baseline(value));
  for (let warmup = 0; warmup < 5; warmup++) {
    measure(baseline, value, iterations);
    measure(formatPermissionErrorDetail, value, iterations);
  }
  for (const [comparison, candidate] of [["A/A", baseline], ["A/B", formatPermissionErrorDetail]]) {
    const left = [], right = [], ratios = [];
    for (let round = 0; round < 16; round++) {
      let a, b;
      if (round % 2) {
        b = measure(candidate, value, iterations);
        a = measure(baseline, value, iterations);
      } else {
        a = measure(baseline, value, iterations);
        b = measure(candidate, value, iterations);
      }
      left.push(a); right.push(b); ratios.push(a / b);
    }
    results.push({ name, comparison, baselineNs: Math.round(median(left)), candidateNs: Math.round(median(right)), speedup: +median(ratios).toFixed(2) });
  }
}
console.log(JSON.stringify({ results, checksum }, null, 2));
