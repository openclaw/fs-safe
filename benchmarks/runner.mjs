import { registerWatch } from "./watch.mjs";
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
import { measuredSecureFileFeatures } from "./secure-file-contract.mjs";
import { registerPaths } from "./paths.mjs";
import { registerLifecycle } from "./lifecycle.mjs";
import { registerDarwinClone } from "./darwin-clone.mjs";
import { registerArchives } from "./archives.mjs";
import { registerBroad } from "./broad.mjs";
import { registerPrivateLockedJson } from "./private-locked-json.mjs";
import { registerLockOwnershipParsing, validateLockOwnershipParsingReport } from "./lock-ownership-parsing.mjs";
import { registerScaling } from "./scaling.mjs";
import { registerCollections } from "./collections.mjs";
import { registerSyncStoreDirectoryModes } from "./sync-store-directory-mode.mjs";
import { registerGuest, validateGuestBenchmarkReport } from "./guest.mjs";
import { validateCopyFallbackSuccessReport } from "./copy-fallback-success.mjs";
import { validateSyncCopyFallbackAdmissionReport } from "./sync-copy-fallback-admission.mjs";
import {
  validateCopyTreeSuccessReport,
  validateProbeTreeSuccessReport,
} from "./copy-tree-success.mjs";
import { validateWindowsOwnerCaughtFailureReport } from "./windows-owner-caught-failure.mjs";
import { observeFilenameFallbackProfile } from "./filename-fallback-profile.mjs";
import {
  MEASURED_SOURCE_ARGUMENT_NAMES,
  SAMPLE_SEMANTICS,
  measuredDistributionMetadata,
  parseMeasuredSourceArguments,
} from "./measured-distribution.mjs";
import { finalizeBenchmarkReport, finishBenchmarkInvocation } from "./runner-cleanup.mjs";

const args = { iterations: 100, samples: 5, warmup: 5, mode: "off", "copy-shape": "mixed", "copy-files": 64, "copy-file-bytes": 4096 };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  if (key === "") continue;
  const allowed = [
    "iterations", "samples", "warmup", "mode", "json", "filter", "dist",
    "copy-shape", "copy-files", "copy-file-bytes", "copy-concurrency",
    ...MEASURED_SOURCE_ARGUMENT_NAMES,
  ];
  if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  const value = process.argv[++i];
  if (value === undefined) throw new Error(`Missing value for ${key}`);
  args[key] = ["iterations", "samples", "warmup", "copy-files", "copy-file-bytes"].includes(key) ? Number(value) : value;
}
for (const key of ["iterations", "samples", "warmup"]) {
  assert(Number.isSafeInteger(args[key]) && args[key] >= (key === "warmup" ? 0 : 1), `Invalid ${key}`);
}
assert(["off", "require", "auto"].includes(args.mode), "Invalid native mode");
assert(["empty", "flat", "nested", "mixed"].includes(args["copy-shape"]), "Invalid copy shape");
assert(Number.isSafeInteger(args["copy-files"]) && args["copy-files"] >= 0 && args["copy-files"] <= 100_000, "Invalid copy file count");
assert(Number.isSafeInteger(args["copy-file-bytes"]) && args["copy-file-bytes"] >= 0 && args["copy-file-bytes"] <= 1024 * 1024, "Invalid copy file size");
assert(args["copy-files"] * args["copy-file-bytes"] <= 512 * 1024 * 1024, "Copy fixture exceeds 512 MiB");
if (args["copy-concurrency"] !== undefined) {
  args["copy-concurrency"] = args["copy-concurrency"].split(",").map(Number);
  assert(args["copy-concurrency"].length > 0 && args["copy-concurrency"].every(value => Number.isInteger(value) && value >= 1 && value <= 32), "Invalid copy concurrency");
  assert(new Set(args["copy-concurrency"]).size === args["copy-concurrency"].length, "Duplicate copy concurrency");
}
const packageRoot = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(args.dist ?? path.join(packageRoot, "dist"));
const distHash = createHash("sha256").update(
  fs.readdirSync(dist)
    .filter((name) => /\.(js|wasm)$/u.test(name))
    .sort()
    .map((name) => name + createHash("sha256")
      .update(fs.readFileSync(path.join(dist, name))).digest("hex"))
    .join("\n"),
).digest("hex");
const measuredSource = parseMeasuredSourceArguments(args);
const measuredFeatures = measuredSecureFileFeatures(dist);
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
const observedFilenameFallback = observeFilenameFallbackProfile(api.sanitizeUntrustedFileName);
const measuredProfiles = {
  expectedFilenameFallback: measuredSource?.expectedFilenameFallbackProfile ?? observedFilenameFallback,
  observedFilenameFallback,
};
const measuredDistribution = measuredDistributionMetadata(
  measuredSource,
  observedFilenameFallback,
  distHash,
);
api.configureFsSafeNative({ mode: args.mode });
const { getNativeBinding } = await import(pathToFileURL(path.join(dist, "native.js")));
const binding = getNativeBinding();
const { PermissionCommandError } = await import(
  pathToFileURL(path.join(dist, "permission-exec.js"))
);
const native = Boolean(binding);
const loadedAddon = native ? Object.values(createRequire(import.meta.url).cache)
  .find((module) => module?.filename.endsWith(".node") && module.exports === binding) : undefined;
assert(!native || loadedAddon, "Could not identify the loaded native addon");
const nativeHash = loadedAddon
  ? createHash("sha256").update(fs.readFileSync(loadedAddon.filename)).digest("hex") : null;
const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-methods-")));
const workspaceFilesystem = fs.statfsSync(workspace);
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
const context = {
  api, workspace, native, binding, measuredFeatures, measuredProfiles,
  PermissionCommandError,
  register, exclude, contract, args, onCleanup: (fn) => cleanups.push(fn),
};
let cleanup;
let completedReport;
let completionMessage;
const executionFailures = [];
try {
  cleanup = await registerCore(context);
  await registerPaths(context);
  await registerLifecycle(context);
  await registerDarwinClone(context);
  await registerArchives(context);
  await registerBroad(context);
  registerPrivateLockedJson(context);
  registerLockOwnershipParsing(context);
  await registerScaling(context);
  await registerCollections(context);
  await registerWatch(context);
  registerSyncStoreDirectoryModes(context);
  const guest = registerGuest(context);
  const covered = new Set(cases.flatMap((c) => c.covers));
  const required = [...exportsByName.keys(), ...[...contracts].flatMap(([type, keys]) => keys.map((key) => `${type}.${key}`))];
  const missing = required.filter((name) => !covered.has(name) && !exclusions.has(name));
  assert.deepEqual(missing, [], `Unmeasured methods: ${missing.join(", ")}`);
  const results = [];
  for (const c of cases) {
    if (args.filter && !c.name.includes(args.filter)) continue;
    if (c.skip) {
      results.push({
        name: c.name,
        skipped: c.skip,
        workloadSemantics: c.workloadSemantics,
        workloadDetails: c.workloadDetails,
        fixturePlacement: c.fixturePlacement,
      });
      continue;
    }
    const iterations = Math.max(1, Math.floor(args.iterations / (c.divisor ?? 1))) *
      (c.sync && !c.before && !c.after ? (c.batch ?? 1) : 1);
    const once = async (timed) => {
      const input = await c.before?.();
      let output;
      let elapsed;
      const invocationFailures = [];
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
        elapsed = performance.now() - start;
        if (c.expectError && !rejected) throw new Error(`${c.name} unexpectedly succeeded`);
        if (!timed) c.verify?.(output);
      } catch (error) {
        invocationFailures.push(error);
      }
      await finishBenchmarkInvocation(
        invocationFailures,
        () => c.after?.(output, input),
        `${c.name} invocation and cleanup failed`,
      );
      return elapsed;
    };
    const samplesUs = [];
    for (let i = 0; i < args.warmup; i++) await once(false);
    // Always run one checked call, including --warmup 0.
    await once(false);
    for (let sample = 0; sample < args.samples; sample++) {
      let elapsed = 0;
      if (c.sync && !c.before && !c.after && !c.expectError) {
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
    const result = {
      name: c.name,
      iterations,
      samplesUs,
      medianUs,
      minUs: sorted[0],
      maxUs: sorted.at(-1),
      workloadSemantics: c.workloadSemantics,
      workloadDetails: c.workloadDetails,
      fixturePlacement: c.fixturePlacement,
    };
    results.push(result);
    process.stderr.write(`${c.name}: ${medianUs.toFixed(2)} us/call\n`);
  }
  completedReport = {
    schemaVersion: 1,
    copyFixture: { shape: args["copy-shape"], files: args["copy-shape"] === "empty" ? 0 : args["copy-files"], bytesPerFile: args["copy-file-bytes"], extraPayloadBytes: args["copy-shape"] === "mixed" ? 1024 * 1024 : 0, concurrency: args["copy-concurrency"] ?? null },
    metadata: {
      harnessHash: harnessDigest,
      nativeHash,
      distHash,
      measuredDistribution,
      guest,
      sampleSemantics: SAMPLE_SEMANTICS,
      harnessRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: packageRoot,
        encoding: "utf8",
      }).trim(),
      node: process.version,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      workspaceFilesystem: {
        type: workspaceFilesystem.type,
        blockSize: workspaceFilesystem.bsize,
      },
      mode: args.mode,
      native,
      samples: args.samples,
      date: new Date().toISOString(),
    },
    coverage: { exports: Object.fromEntries(exportsByName), methods: Object.fromEntries(contracts), exclusions: Object.fromEntries(exclusions), registeredCases: cases.length, filtered: Boolean(args.filter) },
    results,
  };
  completionMessage = `Measured ${results.filter((r) => !r.skipped).length} cases; ${required.length} callable exports/methods accounted for. Native ${args.mode}: ${native ? "loaded" : "off/unavailable"}.\n`;
} catch (error) {
  executionFailures.push(error);
}
await finalizeBenchmarkReport({
  initialFailures: executionFailures,
  validateReport: () => {
    validateLockOwnershipParsingReport(completedReport, args.filter, args.iterations);
    validateSyncCopyFallbackAdmissionReport(completedReport, args.filter, args.iterations);
    validateGuestBenchmarkReport(completedReport, args.filter);
    validateCopyFallbackSuccessReport(completedReport, args.filter, args.iterations);
    validateProbeTreeSuccessReport(completedReport, args.filter, args.iterations);
    validateCopyTreeSuccessReport(completedReport, args.filter, args.iterations);
    validateWindowsOwnerCaughtFailureReport(completedReport, args.filter, args.iterations);
  },
  cleanup,
  cleanups,
  workspace,
  reportPath: args.json ? path.resolve(args.json) : undefined,
  report: completedReport,
});
process.stdout.write(completionMessage);
