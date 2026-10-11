// Usage: node benchmarks/root-walk-prefix-comparison.mjs BASE_DIST CANDIDATE_DIST [pairs=15]
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHook } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [baseDirectory, candidateDirectory, pairCount = "15"] = process.argv.slice(2);
if (!baseDirectory || !candidateDirectory) throw new Error("supply baseline and candidate dist directories");
const pairs = Number(pairCount);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const load = async directory => {
  const url = filename => pathToFileURL(path.resolve(directory, filename)).href;
  const config = await import(url("config.js"));
  const native = await import(url("native.js"));
  config.configureFsSafeNative({ mode: "require" });
  assert(native.getNativeBinding(), "require must load the platform binding");
  return { ...(await import(url("root.js"))), ...(await import(url("walk.js"))), ...config };
};
const base = await load(baseDirectory), candidate = await load(candidateDirectory);
const tree = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fs-safe-walk-bench-"));
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const geometric = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
const rows = [];
try {
  for (const width of [1000, 50000]) {
    const directory = path.join(tree, String(width));
    fs.mkdirSync(directory);
    for (let file = 0; file < width; file++) fs.writeFileSync(path.join(directory, String(file)), "");
    const roots = { a: await base.root(directory), b: await candidate.root(directory) };
    for (const operation of ["walk", "walkDirectory", "walkDirectorySync"]) {
      const sync = operation === "walkDirectorySync";
      const raw = operation === "walk" ? async () => {
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        for (const entry of entries) fs.lstatSync(path.join(directory, entry.name));
        return entries.length;
      } : sync ? () => fs.readdirSync(directory, { withFileTypes: true }).length
        : async () => (await fsp.readdir(directory, { withFileTypes: true })).length;
      const safe = (api, root) => operation === "walk" ? async () => {
        let count = 0;
        for await (const _entry of root.walk("", { symlinkPolicy: "skip" })) count++;
        return count;
      } : sync ? () => api.walkDirectorySync(directory).entries.length
        : async () => (await api.walkDirectory(directory)).entries.length;
      const calls = { raw, aa: raw, aOff: safe(base, roots.a), bOff: safe(candidate, roots.b),
        aRequire: safe(base, roots.a), bRequire: safe(candidate, roots.b) };
      const run = async (role, observe = false) => {
        const api = role.startsWith("a") && role !== "aa" ? base : candidate;
        if (role !== "raw" && role !== "aa") api.configureFsSafeNative({ mode: role.endsWith("Off") ? "off" : "require" });
        const resources = {}, filesystem = {}, restore = [];
        const hook = observe ? createHook({ init(_id, type) { resources[type] = (resources[type] ?? 0) + 1; } }) : undefined;
        if (observe) {
          const wrap = (object, name, label) => {
            const original = object[name];
            object[name] = Object.assign(function (...args) {
              filesystem[label] = (filesystem[label] ?? 0) + 1;
              return Reflect.apply(original, this, args);
            }, original);
            restore.push(() => { object[name] = original; });
          };
          wrap(fs, "lstatSync", "lstatSync");
          wrap(fs.realpathSync, "native", "realpathSync.native");
          wrap(fs, "realpathSync", "realpathSync");
          wrap(fs, "readdirSync", "readdirSync");
          wrap(fsp, "readdir", "readdir");
        }
        // Keep garbage from a previous arm out of the next arm's measurement.
        global.gc?.();
        let count;
        const iterations = observe || width === 50000 ? 1 : 5;
        let elapsed;
        try {
          hook?.enable();
          const start = performance.now();
          for (let index = 0; index < iterations; index++) count = sync ? calls[role]() : await calls[role]();
          elapsed = (performance.now() - start) * 1000 / iterations;
        } finally {
          hook?.disable();
          for (const undo of restore.reverse()) undo();
        }
        assert.equal(count, width);
        return observe ? { resources, filesystem } : elapsed;
      };
      const roles = Object.keys(calls);
      for (let i = 0; i < 3; i++) for (const role of roles) await run(role);
      const samples = [];
      for (let index = 0; index < pairs; index++) {
        const sample = {};
        for (const role of index % 2 ? roles.toReversed() : roles) sample[role] = await run(role);
        samples.push(sample);
      }
      const mediansUs = Object.fromEntries(roles.map(role => [role, median(samples.map(s => s[role]))]));
      const ratio = (numerator, denominator) => geometric(samples.map(s => s[numerator] / s[denominator]));
      const mechanism = {};
      for (const role of roles.filter(role => role !== "aa")) mechanism[role] = await run(role, true);
      const row = { operation: `${operation}-${width}`, mediansUs,
        pairedRatio: { off: ratio("bOff", "aOff"), require: ratio("bRequire", "aRequire"),
          nativeBefore: ratio("aRequire", "aOff"), nativeAfter: ratio("bRequire", "bOff"), aa: ratio("aa", "raw") },
        mechanism, samples };
      rows.push(row);
      console.error(`${row.operation}: off=${row.pairedRatio.off.toFixed(3)} require=${row.pairedRatio.require.toFixed(3)} A/A=${row.pairedRatio.aa.toFixed(3)}`);
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    explicitGc: Boolean(global.gc), cpu: os.cpus()[0]?.model, filesystem: `0x${fs.statfsSync(tree).type.toString(16)}`, pairs,
    baseDirectory, candidateDirectory, rows }, null, 2));
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}
