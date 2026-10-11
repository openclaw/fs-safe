#!/usr/bin/env node
// Campaign 2's public-operation survey, made reproducible alongside the method audit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { nodeBaselineCases } from "./node-baseline-cases.mjs";
import { finalizeBenchmarkRun, finishBenchmarkInvocation } from "./runner-cleanup.mjs";
import { median, parseSyscalls, renderNodeBaseline } from "./node-baseline-report.mjs";

const args = { mode: "both", iterations: 30, samples: 7, warmup: 3, filter: "", "temp-root": os.tmpdir() };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/u, "");
  if (key === "") continue;
  if (["syscalls", "trace-only", "help"].includes(key)) { args[key] = true; continue; }
  assert(["mode", "iterations", "samples", "warmup", "filter", "temp-root", "json", "markdown", "dist"].includes(key), `Unknown argument: ${key}`);
  const value = process.argv[++i];
  assert(value !== undefined && !value.startsWith("--"), `Missing value: ${key}`);
  args[key] = ["iterations", "samples", "warmup"].includes(key) ? Number(value) : value;
}
if (args.help) {
  console.log("pnpm benchmark:node [--mode both|off|require] [--iterations 30] [--samples 7] [--warmup 3] [--filter substring] [--temp-root directory] [--json report.json] [--markdown report.md] [--syscalls] [--dist dist]");
  process.exit(0);
}
assert(["both", "off", "require"].includes(args.mode), "Invalid native mode");
for (const key of ["iterations", "samples", "warmup"]) assert(Number.isSafeInteger(args[key]) && args[key] >= (key === "warmup" ? 0 : 1), `Invalid ${key}`);
assert(!args.syscalls || process.platform === "linux", "--syscalls needs Linux and strace");
const packageRoot = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(args.dist ?? path.join(packageRoot, "dist"));
const write = (file, data) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, data); };
const forwarded = () => ["iterations", "samples", "warmup", "filter", "temp-root", "dist"].filter((key) => args[key] !== undefined).flatMap((key) => [`--${key}`, String(args[key])]);
const runChild = (command, argv) => {
  const result = spawnSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed (${result.signal ?? result.status})`);
  return result.stdout;
};
if (args.mode === "both") {
  assert(!args["trace-only"], "Trace needs one native mode");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-baseline-reports-"));
  const reports = [];
  try {
    for (const mode of ["off", "require"]) {
      const file = path.join(directory, `${mode}.json`);
      runChild(process.execPath, [import.meta.filename, ...forwarded(), "--mode", mode, "--json", file, ...(args.syscalls ? ["--syscalls"] : [])]);
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      reports.push(report);
      if (args.json) {
        const base = args.json.replace(/\.json$/u, "");
        write(`${base}-${mode}.json`, JSON.stringify(report, null, 2) + "\n");
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const markdown = renderNodeBaseline(reports);
  if (args.json) write(args.json, JSON.stringify({ schemaVersion: 1, reports }, null, 2) + "\n");
  if (args.markdown) write(args.markdown, markdown);
  process.stdout.write(markdown);
} else {
  await runMode();
}

async function runMode() {
  const api = {};
  for (const sub of ["index", "advanced", "atomic", "json", "store", "file-lock", "temp", "walk", "archive", "durability"]) {
    Object.assign(api, await import(pathToFileURL(path.join(dist, `${sub}.js`))));
  }
  api.configureFsSafeNative({ mode: args.mode });
  const { getNativeBinding } = await import(pathToFileURL(path.join(dist, "native.js")));
  const binding = getNativeBinding();
  assert(args.mode !== "require" || binding, "Native require must load a binding");
  const addon = binding ? Object.values(createRequire(import.meta.url).cache).find((m) => m?.filename.endsWith(".node") && m.exports === binding) : undefined;
  assert(!binding || addon, "Cannot identify loaded native artifact");
  const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(path.resolve(args["temp-root"]), "fs-safe-node-")));
  const loadStart = os.loadavg();
  let report;
  const failures = [];
  try {
    const cases = await nodeBaselineCases(api, workspace, args.filter);
    assert(cases.length > 0, "Filter selected no operations");
    const results = [];
    async function once(row, role, observe = false) {
      const implementation = role === "rawControl" ? "raw" : role;
      const input = await row.before?.(implementation);
      let output;
      let elapsed;
      const errors = [];
      const resources = {};
      const hook = observe ? createHook({ init(_, type) { resources[type] = (resources[type] ?? 0) + 1; } }) : undefined;
      try {
        if (args["trace-only"]) fs.writeSync(2, `TRACE_START ${row.operation} ${implementation}\n`);
        hook?.enable();
        const start = process.hrtime.bigint();
        try { output = row.sync ? row[implementation](input) : await row[implementation](input); }
        finally { elapsed = Number(process.hrtime.bigint() - start); hook?.disable(); }
        if (args["trace-only"]) fs.writeSync(2, `TRACE_END ${row.operation} ${implementation}\n`);
        row.verify?.(output, implementation, input);
      } catch (error) { errors.push(error); }
      await finishBenchmarkInvocation(errors, () => row.after?.(output, implementation, input), `${row.operation} invocation/cleanup failed`);
      return { elapsed, resources };
    }
    for (const row of cases) {
      console.error(`node-baseline: ${args.mode} ${row.operation}`);
      const iterations = Math.min(row.iterations ?? args.iterations, args.iterations);
      if (args["trace-only"]) {
        // Warm without markers; then trace exactly one verified invocation per arm.
        const tracing = args["trace-only"];
        args["trace-only"] = false;
        for (const role of ["raw", "safe"]) await once(row, role);
        args["trace-only"] = tracing;
        for (const role of ["raw", "safe"]) await once(row, role);
        continue;
      }
      for (const role of ["raw", "safe", "rawControl"]) {
        for (let i = 0; i < Math.max(1, args.warmup); i++) await once(row, role);
      }
      const samples = { raw: [], safe: [], rawControl: [] };
      for (let block = 0; block < args.samples; block++) {
        for (const role of block % 2 ? ["rawControl", "safe", "raw"] : ["raw", "safe", "rawControl"]) {
          let elapsed = 0;
          for (let i = 0; i < iterations; i++) elapsed += (await once(row, role)).elapsed;
          samples[role].push(elapsed / iterations);
        }
      }
      const resources = {};
      for (const role of ["raw", "safe"]) resources[role] = (await once(row, role, true)).resources;
      const rawNs = median(samples.raw), safeNs = median(samples.safe);
      results.push({ operation: row.operation, platform: process.platform, node: process.version, mode: args.mode,
        sync: Boolean(row.sync), control: Boolean(row.control), iterations, samples, rawNs, safeNs, ratio: safeNs / rawNs,
        pairedRatio: median(samples.safe.map((ns, i) => ns / samples.raw[i])),
        aa: { rawNs, controlNs: median(samples.rawControl), ratio: median(samples.rawControl) / rawNs,
          pairedRatio: median(samples.rawControl.map((ns, i) => ns / samples.raw[i])) },
        caveat: row.caveat, resources });
    }
    if (!args["trace-only"]) {
      let revision = null;
      try { revision = execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* A packaged dist may have no Git checkout. */ }
      report = { schemaVersion: 1, metadata: { platform: process.platform, arch: process.arch, node: process.version,
        packageVersion: JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version,
        revision, mode: args.mode, nativeLoaded: Boolean(binding), nativeSha256: addon ? hash(addon.filename) : null,
        distSha256: createHash("sha256").update(fs.readdirSync(dist).filter((n) => /\.(js|wasm)$/u.test(n)).sort().map((n) => n + hash(path.join(dist, n))).join("\n")).digest("hex"),
        harnessSha256: createHash("sha256").update(["node-baseline.mjs", "node-baseline-cases.mjs", "node-baseline-report.mjs"].map((n) => hash(path.join(import.meta.dirname, n))).join("\n")).digest("hex"),
        filesystem: `0x${fs.statfsSync(workspace).type.toString(16)}`, cpu: os.cpus()[0]?.model, cpuCount: os.availableParallelism(),
        date: new Date().toISOString(), samples: args.samples, iterations: args.iterations, warmup: Math.max(1, args.warmup),
        payloadBytes: 23, treeEntries: [1000, 50000], loadStart, loadEnd: os.loadavg(),
        method: "Median sample means in ns/op; alternating raw/safe/rawControl and reverse blocks; setup, verification, cleanup excluded. Resources observed separately. Raw is NOT security-equivalent." }, results };
    }
  } catch (error) { failures.push(error); }
  await finalizeBenchmarkRun({ initialFailures: failures, workspace });
  if (args["trace-only"]) return;
  if (args.syscalls) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-strace-"));
    try {
      const trace = path.join(directory, "trace.log");
      runChild("strace", ["-f", "-qq", "-yy", "-s", "512", "-e", "trace=%file,read,write,close,fsync,fdatasync,fstat,getdents64,copy_file_range,sendfile,ioctl", "-o", trace,
        process.execPath, import.meta.filename, ...forwarded(), "--mode", args.mode, "--trace-only"]);
      const counts = parseSyscalls(fs.readFileSync(trace, "utf8"));
      for (const row of report.results) {
        row.syscalls = {};
        for (const role of ["raw", "safe"]) {
          assert(counts[`${row.operation}/${role}`], `Missing syscall window: ${row.operation}/${role}`);
          row.syscalls[role] = counts[`${row.operation}/${role}`];
        }
      }
      report.metadata.syscalls = "One separate warmed invocation per arm; selected filesystem/descriptor calls on all threads; excludes trace markers, pipes, sockets and anon_inode descriptors. Not latency evidence.";
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  if (args.json) write(args.json, JSON.stringify(report, null, 2) + "\n");
  const markdown = renderNodeBaseline([report]);
  if (args.markdown) write(args.markdown, markdown);
  process.stdout.write(markdown);
}
