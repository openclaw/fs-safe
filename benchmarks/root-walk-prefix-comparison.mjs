// Usage: node benchmarks/root-walk-prefix-comparison.mjs BASE_DIST CANDIDATE_DIST [pairs=24]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [baseDirectory, candidateDirectory, pairCount = "24"] = process.argv.slice(2);
if (!baseDirectory || !candidateDirectory) throw new Error("supply baseline and candidate dist directories");
const pairs = Number(pairCount);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const load = async directory => {
  const url = filename => pathToFileURL(path.resolve(directory, filename)).href;
  (await import(url("config.js"))).configureFsSafeNative({ mode: "off" });
  return import(url("root.js"));
};
const base = await load(baseDirectory), candidate = await load(candidateDirectory);
const tree = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fs-safe-walk-bench-"));
try {
  for (let index = 0; index < 100; index++) {
    const directory = path.join(tree, `package-${index}`);
    fs.mkdirSync(directory);
    for (let file = 0; file < 500; file++) fs.writeFileSync(path.join(directory, `${file}.js`), "export default 1;\n");
  }
  const roots = { a: await base.root(tree), b: await candidate.root(tree) };
  const run = async implementation => {
    let count = 0;
    const start = performance.now();
    for await (const entry of implementation.walk("", { symlinkPolicy: "skip" })) {
      assert(entry.kind === "file" || entry.kind === "directory");
      count++;
    }
    const elapsed = performance.now() - start;
    assert.equal(count, 50100);
    return elapsed;
  };
  for (let index = 0; index < 3; index++) { await run(roots.a); await run(roots.b); }
  const samples = [];
  for (let index = 0; index < pairs; index++) {
    const sample = {};
    const order = index % 2 ? ["b", "a", "aa2", "aa1"] : ["a", "b", "aa1", "aa2"];
    for (const name of order) sample[name] = await run(name === "b" ? roots.b : roots.a);
    samples.push(sample);
  }
  const counts = async implementation => {
    const observed = { lstat: 0, realpath: 0, joins: 0 };
    const lstat = fs.lstatSync, realpath = fs.realpathSync.native, join = path.posix.join;
    fs.lstatSync = (...args) => { observed.lstat++; return lstat(...args); };
    fs.realpathSync.native = (...args) => { observed.realpath++; return realpath(...args); };
    path.posix.join = (...args) => { observed.joins++; return join(...args); };
    try { await run(implementation); } finally {
      fs.lstatSync = lstat; fs.realpathSync.native = realpath; path.posix.join = join;
    }
    return observed;
  };
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const geometric = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch, files: 50000, pairs,
    medianBaseMs: median(samples.map(sample => sample.a)),
    medianCandidateMs: median(samples.map(sample => sample.b)),
    pairedRatio: geometric(samples.map(sample => sample.b / sample.a)),
    aaRatio: geometric(samples.map(sample => sample.aa2 / sample.aa1)),
    observations: { base: await counts(roots.a), candidate: await counts(roots.b) }, samples,
  }, null, 2));
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}
