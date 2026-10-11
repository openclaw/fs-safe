// Run after pnpm build. Optional first argument: another built package's dist/advanced.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as candidate from "../dist/advanced.js";
import { configureFsSafeNative } from "../dist/config.js";

const args = { count: 3000, rounds: 3, warmup: 1, depth: 4, mode: "off", "temp-root": os.tmpdir() };
let baselinePath;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--") && !baselinePath) { baselinePath = arg; continue; }
  const key = arg.slice(2);
  assert(Object.hasOwn(args, key), `Unknown argument: ${arg}`);
  const value = process.argv[++i];
  assert(value !== undefined && !value.startsWith("--"), `Missing value: ${arg}`);
  args[key] = ["count", "rounds", "warmup", "depth"].includes(key) ? Number(value) : value;
}
for (const key of ["count", "rounds", "warmup"]) assert(Number.isSafeInteger(args[key]) && args[key] >= (key === "warmup" ? 0 : 1));
assert(["off", "require", "both"].includes(args.mode));
assert([0, 4].includes(args.depth), "depth must be 0 or 4");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const base = fs.realpathSync(fs.mkdtempSync(path.join(path.resolve(args["temp-root"]), "fs-safe-copy-bench-")));
const sourceRoot = path.join(base, "source");
const content = Buffer.alloc(1024, 0x5a);
const files = Array.from({ length: args.count }, (_, i) => args.depth === 0 ? `file${i}.js` : `packages/p${i % 30}/lib/nested/file${i}.js`);
const modules = [{ name: "candidate", api: candidate, configure: configureFsSafeNative }];
if (baselinePath) {
  const url = pathToFileURL(path.resolve(baselinePath));
  const api = await import(url.href);
  const config = await import(new URL("config.js", url).href);
  modules.unshift({ name: "baseline", api, configure: config.configureFsSafeNative });
}
try {
  for (const relative of files) {
    const file = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const reports = [];
  for (const mode of args.mode === "both" ? ["off", "require"] : [args.mode]) {
    for (const module of modules) module.configure({ mode });
    const implementations = [{ name: "raw", raw: true }, { name: "raw-control", raw: true }];
    for (const module of modules) for (const batch of [false, true]) {
      implementations.push({ name: `${module.name}-${batch ? "batch" : "single"}`, api: module.api, batch });
      if (module.name === "baseline") implementations.push({ name: `${module.name}-control-${batch ? "batch" : "single"}`, api: module.api, batch });
    }
    const timings = new Map(implementations.map(({ name }) => [name, []]));
    for (let round = -args.warmup; round < args.rounds; round++) {
      // Alternate direction and rotate arms, interleaving A/A and A/B on the same disk.
      const offset = (round + args.warmup) % implementations.length;
      const order = [...implementations.slice(offset), ...implementations.slice(0, offset)];
      if (round % 2) order.reverse();
      for (const { name, raw, api, batch } of order) {
        const targetRoot = path.join(base, "target");
        for (const relative of files) fs.mkdirSync(path.dirname(path.join(targetRoot, relative)), { recursive: true });
        const owner = batch ? api.createRootFileCopyBatchSync() : undefined;
        const start = performance.now();
        try {
          for (const relative of files) {
            const source = path.join(sourceRoot, relative);
            const destination = path.join(targetRoot, relative);
            if (raw) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            else {
              const options = {
                source: { rootPath: sourceRoot, absolutePath: source },
                destination: { rootPath: targetRoot, absolutePath: destination },
                maxBytes: content.length,
              };
              const copied = owner ? owner.copyFile(options) : api.copyRootFileSync(options);
              copied.close();
            }
          }
        } finally { owner?.close(); }
        const elapsed = performance.now() - start;
        if (round >= 0) timings.get(name).push(elapsed * 1000 / args.count);
        // Every output is verified outside timing, including raw and A/A arms.
        for (const relative of files) assert.deepEqual(fs.readFileSync(path.join(targetRoot, relative)), content);
        fs.rmSync(targetRoot, { recursive: true });
      }
    }
    reports.push({ mode, results: [...timings].map(([name, samplesUs]) => ({ name, samplesUs, medianUs: median(samplesUs) })) });
  }
  console.log(JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version,
    files: args.count, bytesPerFile: content.length, leafParents: args.depth === 0 ? 1 : Math.min(args.count, 30), directoryDepth: args.depth,
    rounds: args.rounds, warmup: args.warmup, filesystem: `0x${fs.statfsSync(base).type.toString(16)}`, reports,
  }, null, 2));
} finally { fs.rmSync(base, { recursive: true, force: true }); }
