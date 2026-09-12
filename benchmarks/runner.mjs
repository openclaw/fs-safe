import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { registerCore } from "./core.mjs";
import { registerPaths } from "./paths.mjs";
import { registerLifecycle } from "./lifecycle.mjs";
import { registerArchives } from "./archives.mjs";

const args = { iterations: 100, samples: 5, warmup: 5, mode: "off" };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  if (key === "") continue;
  if (!["iterations", "samples", "warmup", "mode", "json", "filter", "dist"].includes(key)) throw new Error(`Unknown argument: ${key}`);
  const value = process.argv[++i];
  if (value === undefined) throw new Error(`Missing value for ${key}`);
  args[key] = ["iterations", "samples", "warmup"].includes(key) ? Number(value) : value;
}
for (const key of ["iterations", "samples", "warmup"]) {
  assert(Number.isSafeInteger(args[key]) && args[key] >= (key === "warmup" ? 0 : 1), `Invalid ${key}`);
}
assert(["off", "require", "auto"].includes(args.mode), "Invalid native mode");
const packageRoot = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(args.dist ?? path.join(packageRoot, "dist"));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const harnessHash = createHash("sha256");
for (const name of fs.readdirSync(import.meta.dirname).filter((name) => name.endsWith(".mjs")).sort()) {
  harnessHash.update(name).update(fs.readFileSync(path.join(import.meta.dirname, name)));
}
for (const name of ["package.json", "pnpm-lock.yaml"]) harnessHash.update(fs.readFileSync(path.join(packageRoot, name)));
const harnessDigest = harnessHash.digest("hex");
const api = {};
const exportsByName = new Map();
for (const [subpath, target] of Object.entries(manifest.exports)) {
  if (typeof target === "string") continue;
  const module = await import(pathToFileURL(path.join(dist, path.basename(target.default))));
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== "function") { api[name] = value; continue; }
    if (name in api) assert.equal(api[name], value, `Ambiguous export: ${name}`);
    api[name] = value;
    exportsByName.set(name, [...(exportsByName.get(name) ?? []), subpath]);
  }
}
api.configureFsSafeNative({ mode: args.mode });
const { getNativeBinding } = await import(pathToFileURL(path.join(dist, "native.js")));
const binding = getNativeBinding();
const native = Boolean(binding);
const loadedAddon = native ? Object.values(createRequire(import.meta.url).cache)
  .find((module) => module?.filename.endsWith(".node") && module.exports === binding) : undefined;
assert(!native || loadedAddon, "Could not identify the loaded native addon");
const nativeHash = loadedAddon
  ? createHash("sha256").update(fs.readFileSync(loadedAddon.filename)).digest("hex") : null;
const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-methods-")));
const cases = [];
const exclusions = new Map();
const contracts = new Map();
const register = (name, run, options = {}) => {
  assert(!cases.some((c) => c.name === name), `Duplicate case: ${name}`);
  cases.push({ name, run, covers: [name.split("/")[0]], ...options });
};
const exclude = (name, reason) => exclusions.set(name, reason);
const contract = (name, object) => {
  const properties = new Set();
  for (let current = object; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const key of Reflect.ownKeys(current)) {
      if (key === "constructor" || key === "context" || key === "mutationOptions") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof descriptor?.value === "function") properties.add(typeof key === "symbol" ? (key === Symbol.asyncDispose ? "[Symbol.asyncDispose]" : key === Symbol.dispose ? "[Symbol.dispose]" : `[${key.description}]`) : key);
    }
  }
  contracts.set(name, [...properties].sort());
};
const cleanups = [];
const context = { api, workspace, native, register, exclude, contract, args, onCleanup: (fn) => cleanups.push(fn) };
let cleanup;
try {
  cleanup = await registerCore(context);
  await registerPaths(context);
  await registerLifecycle(context);
  await registerArchives(context);
  const covered = new Set(cases.flatMap((c) => c.covers));
  const required = [...exportsByName.keys(), ...[...contracts].flatMap(([type, keys]) => keys.map((key) => `${type}.${key}`))];
  const missing = required.filter((name) => !covered.has(name) && !exclusions.has(name));
  assert.deepEqual(missing, [], `Unmeasured methods: ${missing.join(", ")}`);
  const results = [];
  for (const c of cases) {
    if (args.filter && !c.name.includes(args.filter)) continue;
    if (c.skip) { results.push({ name: c.name, skipped: c.skip }); continue; }
    const iterations = c.sync && !c.before && !c.after ? args.iterations * (c.batch ?? 1) : Math.max(1, Math.floor(args.iterations / (c.divisor ?? 1)));
    const once = async (timed) => {
      const input = await c.before?.();
      let output;
      try {
        const start = performance.now();
        let rejected = false;
        try {
          output = c.sync ? c.run(input) : await c.run(input);
        } catch (error) {
          if (!c.expectError) throw error;
          output = error;
          rejected = true;
        }
        const elapsed = performance.now() - start;
        if (c.expectError && !rejected) throw new Error(`${c.name} unexpectedly succeeded`);
        if (!timed) c.verify?.(output);
        return elapsed;
      } finally { await c.after?.(output, input); }
    };
    const samplesUs = [];
    for (let i = 0; i < args.warmup; i++) await once(false);
    // Always run one checked call, including --warmup 0.
    await once(false);
    for (let sample = 0; sample < args.samples; sample++) {
      let elapsed = 0;
      if (c.sync && !c.before && !c.after) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) c.run();
        elapsed = performance.now() - start;
      } else {
        for (let i = 0; i < iterations; i++) elapsed += await once(true);
      }
      samplesUs.push(elapsed * 1000 / iterations);
    }
    const sorted = [...samplesUs].sort((a, b) => a - b);
    const medianUs = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
    const result = { name: c.name, iterations, samplesUs, medianUs, minUs: sorted[0], maxUs: sorted.at(-1) };
    results.push(result);
    process.stderr.write(`${c.name}: ${medianUs.toFixed(2)} us/call\n`);
  }
  const report = {
    schemaVersion: 1,
    metadata: { harnessHash: harnessDigest, nativeHash, distHash: createHash("sha256").update(fs.readdirSync(dist).filter((name) => /\.(js|wasm)$/.test(name)).sort().map((name) => name + createHash("sha256").update(fs.readFileSync(path.join(dist, name))).digest("hex")).join("\n")).digest("hex"), harnessRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim(), node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, mode: args.mode, native, samples: args.samples, date: new Date().toISOString() },
    coverage: { exports: Object.fromEntries(exportsByName), methods: Object.fromEntries(contracts), exclusions: Object.fromEntries(exclusions), registeredCases: cases.length, filtered: Boolean(args.filter) },
    results,
  };
  if (args.json) fs.writeFileSync(path.resolve(args.json), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Measured ${results.filter((r) => !r.skipped).length} cases; ${required.length} callable exports/methods accounted for. Native ${args.mode}: ${native ? "loaded" : "off/unavailable"}.\n`);
} finally {
  await cleanup?.();
  for (const fn of cleanups.reverse()) await fn();
  fs.rmSync(workspace, { recursive: true, force: true });
}
