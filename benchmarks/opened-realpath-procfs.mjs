// node benchmarks/opened-realpath-procfs.mjs BASE_DIST CANDIDATE_DIST [off|require]
// Add A or B as a fourth argument for a 1,000-lookup strace workload.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [baseDist, candidateDist, mode = "off", traceVariant] = process.argv.slice(2);
if (!baseDist || !candidateDist) throw new Error("Supply baseline and candidate dist directories");
const load = async directory => {
  const url = pathToFileURL(path.resolve(directory) + path.sep);
  const api = await import(new URL("root.js", url));
  const resolver = await import(new URL("opened-realpath.js", url));
  const config = await import(new URL("config.js", url));
  config.configureFsSafeNative({ mode });
  return { ...api, ...resolver };
};
const implementations = [await load(baseDist), await load(candidateDist)];
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-procfs-bench-")));
const relative = Array.from({ length: 16 }, (_, i) => `d${i}`).join("/");
const parent = path.join(directory, relative);
fs.mkdirSync(parent, { recursive: true });
const target = path.join(parent, "source");
const data = Buffer.alloc(1024, 120);
fs.writeFileSync(target, data);
const fd = fs.openSync(target, "r");
const identity = fs.fstatSync(fd, { bigint: true });
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  if (traceVariant) {
    const api = implementations[traceVariant === "A" ? 0 : 1];
    for (let i = 0; i < 1000; i++) {
      const result = await api.resolveOpenedFileRealPathForFd(fd, identity, target);
      assert.equal(result.realPath, target);
      assert.equal(result.stat.ino, identity.ino);
    }
  } else {
    const roots = await Promise.all(implementations.map(api => api.root(directory)));
    const cases = [
      { name: "resolve opened fd", count: 3000, run: index => implementations[index].resolveOpenedFileRealPathForFd(fd, identity, target) },
      { name: "readLocalFileSafely", count: 250, run: index => implementations[index].readLocalFileSafely({ filePath: target }) },
      { name: "Root.copyIn", count: 100, run: index => roots[index].copyIn(`${relative}/copy`, target, { durable: false }) },
      { name: "Root.write", count: 100, run: index => roots[index].write(`${relative}/write`, data, { durable: false }) },
    ];
    for (const { name, count, run } of cases) {
      const sample = async index => {
        const start = performance.now();
        for (let i = 0; i < count; i++) await run(index);
        return (performance.now() - start) * 1000 / count;
      };
      await sample(0); await sample(1);
      for (const [comparison, right] of [["A/A", 0], ["A/B", 1]]) {
        const leftTimes = [], rightTimes = [];
        for (let pair = 0; pair < 15; pair++) {
          if (pair % 2) { rightTimes.push(await sample(right)); leftTimes.push(await sample(0)); }
          else { leftTimes.push(await sample(0)); rightTimes.push(await sample(right)); }
        }
        console.log(JSON.stringify({ name, mode, comparison, count, pairs: leftTimes.length,
          baselineUs: median(leftTimes), candidateUs: median(rightTimes),
          pairedRatio: median(rightTimes.map((time, i) => time / leftTimes[i])), leftTimes, rightTimes }));
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(parent, "copy")), data);
    assert.deepEqual(fs.readFileSync(path.join(parent, "write")), data);
  }
} finally { fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }); }
