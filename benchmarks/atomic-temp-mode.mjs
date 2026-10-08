// Run after building both checkouts: node benchmarks/atomic-temp-mode.mjs BASE CANDIDATE
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [base, candidate] = process.argv.slice(2);
if (!base || !candidate) throw new Error("Pass baseline and candidate checkout directories");
const load = async (directory) => (await import(pathToFileURL(path.resolve(directory, "dist/atomic.js")))).replaceFileAtomic;
const baseline = await load(base);
const changed = await load(candidate);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-atomic-mode-"));
const filePath = path.join(directory, "value");
const content = Buffer.alloc(1024, 0x61);
const options = { filePath, content, syncTempFile: false, syncParentDir: false };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function calls(write) {
  const counts = { tempChmod: 0, fstatSync: 0 };
  const open = promises.open;
  const fstat = fs.fstatSync;
  promises.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      const chmod = handle.chmod.bind(handle);
      handle.chmod = (...values) => { counts.tempChmod += 1; return chmod(...values); };
    }
    return handle;
  };
  fs.fstatSync = (...args) => { counts.fstatSync += 1; return fstat(...args); };
  try { await write(options); }
  finally { promises.open = open; fs.fstatSync = fstat; }
  return counts;
}

async function measure(left, right) {
  for (let n = 0; n < 100; n += 1) { await left(options); await right(options); }
  const samples = [[], []];
  const rounds = [];
  for (let round = 0; round < 9; round += 1) {
    const pair = [[], []];
    for (let n = 0; n < 100; n += 1) {
      for (const index of round % 2 ? [1, 0, 0, 1] : [0, 1, 1, 0]) {
        const write = [left, right][index];
        const start = performance.now();
        await write(options);
        const micros = (performance.now() - start) * 1000;
        pair[index].push(micros);
        samples[index].push(micros);
      }
    }
    rounds.push(median(pair[1]) / median(pair[0]));
  }
  assert.deepEqual(fs.readFileSync(filePath), content);
  assert.deepEqual(fs.readdirSync(directory), ["value"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o7777, 0o600);
  return { leftMedianUs: median(samples[0]), rightMedianUs: median(samples[1]), medianPairedRatio: median(rounds), pairedRatios: rounds };
}

try {
  console.log(JSON.stringify({ platform: process.platform, node: process.version,
    bytes: content.length, rounds: 9, operationsPerArmPerRound: 200,
    calls: { baseline: await calls(baseline), candidate: await calls(changed) },
    aa: await measure(baseline, baseline), ab: await measure(baseline, changed) }, null, 2));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
