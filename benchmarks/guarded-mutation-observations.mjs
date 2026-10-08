// Compare compiled trees: node benchmarks/guarded-mutation-observations.mjs <baseline-dist> <candidate-dist>
import { createHook } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) throw new Error('Supply baseline and candidate dist directories');
const load = async directory => import(pathToFileURL(path.resolve(directory, 'guarded-mutation.js')).href);
const a = await load(baseline);
const b = await load(candidate);
const { captureDirectoryGuard } = await import(pathToFileURL(path.resolve(candidate, 'directory-guard.js')).href);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-safe-guard-bench-'));
const iterations = Number(process.env.BENCH_ITERATIONS ?? 10000);
const samples = Number(process.env.BENCH_SAMPLES ?? 9);
const median = values => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
try {
  const guard = captureDirectoryGuard(directory, 'native', { bigint: true });
  const mutate = async () => 1;
  for (const guardCount of [1, 2]) {
    const guards = Array(guardCount).fill(guard);
    const run = async (implementation, count) => {
      const start = performance.now();
      for (let i = 0; i < count; i++) await implementation.withAsyncDirectoryGuards(guards, mutate);
      return (performance.now() - start) * 1000 / count;
    };
    await run(a, 1000);
    await run(b, 1000);
    for (const [comparison, right] of [['A/A', a], ['A/B', b]]) {
      const leftTimes = [], rightTimes = [];
      for (let i = 0; i < samples; i++) {
        if (i % 2 === 0) { leftTimes.push(await run(a, iterations)); rightTimes.push(await run(right, iterations)); }
        else { rightTimes.push(await run(right, iterations)); leftTimes.push(await run(a, iterations)); }
      }
      console.log(JSON.stringify({ guardCount, comparison, iterations, samples,
        leftMedianUs: median(leftTimes), rightMedianUs: median(rightTimes),
        ratio: median(rightTimes) / median(leftTimes), leftTimes, rightTimes }));
    }
    for (const [variant, implementation] of [['A', a], ['B', b]]) {
      let promises = 0, stats = 0, realpaths = 0;
      const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promises++; } });
      const lstat = fs.lstatSync, realpath = fs.realpathSync.native;
      fs.lstatSync = (...args) => { stats++; return lstat(...args); };
      fs.realpathSync.native = (...args) => { realpaths++; return realpath(...args); };
      hook.enable();
      try { await run(implementation, 1000); }
      finally { hook.disable(); fs.lstatSync = lstat; fs.realpathSync.native = realpath; }
      console.log(JSON.stringify({ guardCount, variant, promises, stats, realpaths, operations: 1000 }));
    }
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
