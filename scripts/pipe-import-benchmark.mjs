import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const medians = {};
for (const subpath of ["pipe", "secret"]) {
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const start = performance.now();
      await import('@openclaw/fs-safe/${subpath}');
      console.log(performance.now() - start);
    `], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const elapsed = Number(result.stdout.trim());
    assert.ok(Number.isFinite(elapsed));
    samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  medians[subpath] = { medianMs: samples[7], samplesMs: samples };
}
console.log(JSON.stringify({
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
  platform: process.platform, arch: process.arch, freshProcessesPerSubpath: 15,
  measurement: "dynamic import duration; process startup excluded",
  ...medians,
}, null, 2));
