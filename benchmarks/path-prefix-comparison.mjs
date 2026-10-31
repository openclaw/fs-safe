// node benchmarks/path-prefix-comparison.mjs BASE_DIST CANDIDATE_DIST TEMP_ROOT [iterations=1000]
// Synchronous API control: shared fixture, five A1/B/A2 batches, counts separate from timing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const [baseline, candidate, tempRoot, iterationsArg = "1000"] = process.argv.slice(2);
assert(baseline && candidate && tempRoot, "Supply two dist directories and a temporary parent");
const iterations = Number(iterationsArg);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const load = directory => import(pathToFileURL(path.resolve(directory, "path-prefix.js")));
const base = await load(baseline), next = await load(candidate);
const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, "prefix-control-")));
const nested = path.join(fixture, "workspace", "nested");
fs.mkdirSync(nested, { recursive: true });
const digest = directory => createHash("sha256").update(fs.readFileSync(path.join(directory, "path-prefix.js"))).digest("hex");
const rows = [];
try {
  for (const [shape, input, suffix] of [
    ["existing", nested, []], ["missing", path.join(nested, "future", "child"), ["future", "child"]],
  ]) {
    const roles = [["A1", base], ["B", next], ["A2", base]];
    for (const [, api] of roles) {
      assert.deepEqual(api.resolvePathPrefixSync(input).unresolvedSegments, suffix);
      for (let i = 0; i < 100; i++) api.resolvePathPrefixSync(input);
    }
    for (let round = 0; round < 5; round++) {
      for (const [role, api] of roles) {
        const before = process.threadCpuUsage(), total = process.cpuUsage(), start = performance.now();
        for (let i = 0; i < iterations; i++) api.resolvePathPrefixSync(input);
        const elapsed = performance.now() - start, cpu = process.threadCpuUsage(before), all = process.cpuUsage(total);
        rows.push({ shape, role, round, elapsedUs: elapsed * 1000 / iterations,
          mainCpuUs: (cpu.user + cpu.system) / iterations, totalCpuUs: (all.user + all.system) / iterations });
      }
    }
    for (const [role, api] of roles) {
      const original = fs.lstatSync, originalRealpath = fs.realpathSync.native;
      let lstat = 0, realpath = 0;
      fs.lstatSync = new Proxy(original, { apply(method, receiver, args) {
        lstat++; return Reflect.apply(method, receiver, args);
      } });
      fs.realpathSync.native = new Proxy(originalRealpath, { apply(method, receiver, args) {
        realpath++; return Reflect.apply(method, receiver, args);
      } });
      try { api.resolvePathPrefixSync(input); }
      finally { fs.lstatSync = original; fs.realpathSync.native = originalRealpath; }
      rows.push({ shape, role, lstat, realpath });
    }
  }
  console.log(JSON.stringify({ baselineHash: digest(baseline), candidateHash: digest(candidate),
    node: process.version, platform: process.platform, load: os.loadavg(), iterations, rows }));
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
