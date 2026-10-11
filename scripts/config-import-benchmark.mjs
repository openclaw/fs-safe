import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const samplesMs = [];
const firstStatusSamplesMs = [];
for (let sample = 0; sample < 7; sample++) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const start = performance.now();
    const config = await import('@openclaw/fs-safe/config');
    const importMs = performance.now() - start;
    let firstStatusMs;
    if (typeof config.getFsSafeNativeStatus === 'function') {
      const firstStart = performance.now();
      await config.getFsSafeNativeStatus();
      firstStatusMs = performance.now() - firstStart;
    }
    console.log(JSON.stringify({ importMs, firstStatusMs }));
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { importMs: elapsed, firstStatusMs } = JSON.parse(result.stdout.trim());
  assert.ok(Number.isFinite(elapsed));
  samplesMs.push(elapsed);
  if (firstStatusMs !== undefined) {
    assert.ok(Number.isFinite(firstStatusMs));
    firstStatusSamplesMs.push(firstStatusMs);
  }
}
console.log(JSON.stringify({
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
  platform: process.platform,
  arch: process.arch,
  measurement: "fresh-process dynamic import duration; process startup excluded",
  samplesMs,
  medianMs: [...samplesMs].sort((a, b) => a - b)[3],
  ...(firstStatusSamplesMs.length ? {
    firstStatusSamplesMs,
    firstStatusMedianMs: [...firstStatusSamplesMs].sort((a, b) => a - b)[3],
  } : {}),
}, null, 2));
