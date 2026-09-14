#!/usr/bin/env node
// Frozen paired proof for the producer-isolation integration. Production
// sampling and gates are committed and cannot be overridden.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BASELINE = "1a4625cc01a1fa04992533a37516b83e982b6fcd";
const CANDIDATE = "a01d01e3173c9d2ee03d264298a2fa28d5e9c214";
const PLAN_SHA256 = "50a3ac520e7ccdac7cb1caba93fb0c83c09f13e321f759425bc2db55e0cbde26";
const CHILD_TIMEOUT_MS = 180_000;
const SMOKE = Object.freeze({
  blocks: 1,
  cohorts: 1,
  blocksPerCohort: 1,
  warmupCallsPerWorkload: 1,
  timedCallsPerWorkload: 1,
  bootstrapIterations: 200,
});

const json = (value) => `${JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? item.toString() : item, 2)}\n`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileSha256 = (file) => sha256(fsSync.readFileSync(file));
const errorInfo = (error) => ({
  name: error?.name ?? null,
  code: error?.code ?? null,
  message: error?.message ?? String(error),
  stack: error?.stack ?? null,
});

function writeExclusive(file, value) {
  fsSync.writeFileSync(file, json(value), { flag: "wx", mode: 0o600 });
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fsSync.writeFileSync(temporary, json(value), { flag: "wx", mode: 0o600 });
  fsSync.renameSync(temporary, file);
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function mean(values) {
  assert(values.length > 0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  assert(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function quantile(sorted, probability) {
  const offset = (sorted.length - 1) * probability;
  const lower = Math.floor(offset);
  const fraction = offset - lower;
  return sorted[lower] + (sorted[lower + 1] === undefined
    ? 0
    : fraction * (sorted[lower + 1] - sorted[lower]));
}

function validatePlan(planPath, mode) {
  const bytes = fsSync.readFileSync(planPath);
  const rawDigest = sha256(bytes);
  const plan = JSON.parse(bytes);
  const digest = sha256(json(plan));
  assert.equal(digest, PLAN_SHA256, "production plan semantics changed without updating the frozen harness");
  assert.deepEqual(plan.revisions, { baseline: BASELINE, candidate: CANDIDATE });
  assert.equal(plan.runtime.node, "22.23.2");
  assert.equal(plan.runtime.pnpm, "11.25.0");
  assert.equal(plan.runtime.nativeMode, "off");
  assert.equal(plan.sampling.blocks, 48);
  assert.equal(plan.sampling.cohorts, 4);
  assert.equal(plan.sampling.blocksPerCohort, 12);
  assert.equal(plan.sampling.processesPerBlock, 8);
  assert.equal(plan.sampling.expectedFreshProcesses, 384);
  assert.equal(plan.sampling.warmupCallsPerWorkload, 16);
  assert.equal(plan.sampling.timedCallsPerWorkload, 16);
  assert.deepEqual(plan.sampling.abPatterns, ["ABBA", "BAAB"]);
  assert.deepEqual(plan.sampling.aaPatterns, ["A0A1A1A0", "A1A0A0A1"]);
  assert.equal(plan.sampling.aaRevision, "baseline");
  assert.deepEqual(plan.workloads, [
    { id: "writeSiblingTempFile/direct/64B", api: "sibling", isolation: "direct", payloadBytes: 64 },
    { id: "writeSiblingTempFile/direct/1MiB", api: "sibling", isolation: "direct", payloadBytes: 1_048_576 },
    { id: "writeSiblingTempFile/private/64B", api: "sibling", isolation: "private", payloadBytes: 64 },
    { id: "writeSiblingTempFile/private/1MiB", api: "sibling", isolation: "private", payloadBytes: 1_048_576 },
    { id: "writeExternalFileWithinRoot/direct/64B", api: "output", isolation: "direct", payloadBytes: 64 },
    { id: "writeExternalFileWithinRoot/direct/1MiB", api: "output", isolation: "direct", payloadBytes: 1_048_576 },
    { id: "writeExternalFileWithinRoot/private/64B", api: "output", isolation: "private", payloadBytes: 64 },
    { id: "writeExternalFileWithinRoot/private/1MiB", api: "output", isolation: "private", payloadBytes: 1_048_576 },
  ]);
  assert.equal(plan.analysis.bootstrapIterations, 20_000);
  assert.equal(plan.analysis.movingBlockLength, 4);
  assert.equal(plan.analysis.withinBlock,
    "mean each child then equal-weight the two processes in each arm");
  assert.equal(plan.analysis.estimator, "median paired block log ratios and absolute differences");
  assert.equal(plan.analysis.relativeRegressionPercent, 5);
  assert.equal(plan.analysis.absoluteRegressionMicroseconds, 5);
  if (mode === "production") {
    assert.equal(process.platform, plan.runtime.platform);
    assert.equal(process.arch, plan.runtime.architecture);
    assert.equal(process.versions.node, plan.runtime.node);
  }
  return { plan, digest, rawDigest };
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function gitNames(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
}

function assertRepositoryInputsClean(repo) {
  const tracked = gitNames(repo, ["diff", "--name-only", "-z", "HEAD", "--"]);
  const staged = gitNames(repo, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"]);
  const untrackedCompileInputs = gitNames(repo, [
    "ls-files", "-z", "--others", "--exclude-standard", "--", "src", "archive-core", "archive-wasm",
  ]);
  const ignoredCompileInputs = gitNames(repo, [
    "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--",
    "src", "archive-core", "archive-wasm",
  ]);
  assert.deepEqual(tracked, [], "tracked checkout files changed");
  assert.deepEqual(staged, [], "staged checkout files changed");
  assert.deepEqual(untrackedCompileInputs, [], "untracked compilation inputs exist");
  assert.deepEqual(ignoredCompileInputs, [], "ignored compilation inputs exist");
  return { tracked, staged, untrackedCompileInputs, ignoredCompileInputs };
}

function fingerprintBuildInputs(repo) {
  const selectors = [
    "src", "archive-core", "archive-wasm", "scripts/build-archive-wasm.mjs",
    "scripts/prepack-build.mjs", "package.json", "pnpm-lock.yaml", "tsconfig.json",
    "Cargo.toml", "Cargo.lock",
  ];
  const names = gitNames(repo, ["ls-files", "-z", "--", ...selectors]);
  const files = Object.fromEntries(names.map((name) => [name, fileSha256(path.join(repo, name))]));
  return { files, manifestSha256: sha256(json(files)) };
}

async function fingerprintRepository(repo) {
  const fixed = [
    "package.json", "pnpm-lock.yaml", "src/advanced.ts", "src/output.ts",
    "src/sibling-staged-file.ts", "src/sibling-temp.ts", "src/temp-target.ts",
    "dist/advanced.js", "dist/output.js",
    "dist/sibling-staged-file.js", "dist/sibling-temp.js", "dist/temp-target.js",
    "dist/native-config.js", "dist/native.js",
  ];
  const distFiles = [];
  async function visit(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && /\.(?:js|wasm)$/.test(entry.name)) distFiles.push(relative);
    }
  }
  await visit(path.join(repo, "dist"), "dist");
  const names = [...new Set([...fixed, ...distFiles])].sort();
  const files = {};
  const missing = [];
  for (const name of names) {
    const absolute = path.join(repo, name);
    if (fsSync.existsSync(absolute)) files[name] = fileSha256(absolute);
    else missing.push(name);
  }
  assert.deepEqual(missing, [], "required producer-isolation sources or build outputs are missing");
  return { files, missing, manifestSha256: sha256(json({ files, missing })) };
}

function validateRepositories(plan, baselineDir, candidateDir, mode) {
  const baseline = fsSync.realpathSync(baselineDir);
  const candidate = fsSync.realpathSync(candidateDir);
  for (const repo of [baseline, candidate]) {
    assert(fsSync.statSync(path.join(repo, "dist/advanced.js")).isFile(), "checkout is not built");
    assert(fsSync.statSync(path.join(repo, "dist/output.js")).isFile(), "checkout is not built");
  }
  if (mode === "production") {
    assert.equal(path.basename(baseline), plan.layout.baselineCheckout);
    assert.equal(path.basename(candidate), plan.layout.candidateCheckout);
    assert.equal(baseline.length, candidate.length, "checkout paths must have equal lengths");
    assert.equal(git(baseline, ["rev-parse", "HEAD"]), BASELINE);
    assert.equal(git(candidate, ["rev-parse", "HEAD"]), CANDIDATE);
    assert.equal(git(candidate, ["merge-base", BASELINE, CANDIDATE]), BASELINE);
    execFileSync("git", ["-C", candidate, "merge-base", "--is-ancestor", BASELINE, CANDIDATE]);
  }
  return {
    baseline,
    candidate,
    cleanliness: {
      baseline: assertRepositoryInputsClean(baseline),
      candidate: assertRepositoryInputsClean(candidate),
    },
  };
}

function createFixtures(fixtureDir, workloads) {
  fsSync.mkdirSync(fixtureDir);
  const files = {};
  const payloads = {};
  for (const size of [...new Set(workloads.map(({ payloadBytes }) => payloadBytes))]) {
    const payload = Buffer.alloc(size, 0x61);
    const name = `payload-${size}.bin`;
    const file = path.join(fixtureDir, name);
    fsSync.writeFileSync(file, payload, { flag: "wx", mode: 0o600 });
    files[name] = { bytes: size, sha256: fileSha256(file) };
    payloads[String(size)] = { bytes: size, fillByte: 0x61, sha256: sha256(payload), file: name };
  }
  const manifest = { schema: 1, workloadIds: workloads.map(({ id }) => id), payloads, files };
  writeExclusive(path.join(fixtureDir, "manifest.json"), manifest);
  return manifest;
}

function fixtureHashes(fixtureDir, manifest) {
  return Object.fromEntries(Object.keys(manifest.files)
    .map((name) => [name, fileSha256(path.join(fixtureDir, name))]));
}

function snapshotSystem(label, directory) {
  const disk = typeof fsSync.statfsSync === "function" ? fsSync.statfsSync(directory) : null;
  return {
    label, wallTime: new Date().toISOString(), monotonicNs: process.hrtime.bigint(),
    uptimeSeconds: os.uptime(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(), processResourceUsage: process.resourceUsage(),
    cpuTimes: os.cpus().map(({ speed, times }) => ({ speed, times })),
    disk: disk ? { blockSize: disk.bsize, blocks: disk.blocks, freeBlocks: disk.bfree,
      availableBlocks: disk.bavail, files: disk.files, freeFiles: disk.ffree } : null,
  };
}

function buildSchedule(plan, sample) {
  const random = xorshift32(plan.sampling.scheduleSeed);
  const blocks = [];
  for (let cohort = 0; cohort < sample.cohorts; cohort += 1) {
    const count = sample.blocksPerCohort;
    assert(count === 1 || count === 12, "only the frozen production or structural smoke schedule is allowed");
    const half = Math.floor(count / 2);
    const quartetOrders = shuffle([
      ...Array(half).fill("ab-first"), ...Array(count - half).fill("aa-first"),
    ], random);
    const definitions = [];
    if (count === 1) {
      definitions.push({ baseRotation: 0, abChoice: 0, aaChoice: 0 });
    } else {
      // Opposite quartet orientations at starts zero/four exactly balance every
      // label over all eight Latin positions within each chronological cohort.
      const pairBases = shuffle([0, 4, 0, 4, 0, 4], random);
      const pairs = pairBases.map((baseRotation) => {
        const abFirst = random() < 0.5 ? 0 : 1;
        const aaFirst = random() < 0.5 ? 0 : 1;
        const pair = [
          { baseRotation, abChoice: abFirst, aaChoice: aaFirst },
          { baseRotation, abChoice: 1 - abFirst, aaChoice: 1 - aaFirst },
        ];
        return random() < 0.5 ? pair : pair.reverse();
      });
      definitions.push(...shuffle(pairs, random).flat());
    }
    for (let local = 0; local < count; local += 1) {
      const definition = definitions[local];
      const abPattern = plan.sampling.abPatterns[definition.abChoice];
      const aaPattern = plan.sampling.aaPatterns[definition.aaChoice];
      const ab = [...abPattern].map((label, index) => ({
        comparison: "ab", label, revision: label === "A" ? BASELINE : CANDIDATE,
        rotation: (definition.baseRotation + index) % 8,
      }));
      const aaLabels = aaPattern === "A0A1A1A0"
        ? ["A0", "A1", "A1", "A0"] : ["A1", "A0", "A0", "A1"];
      const aa = aaLabels.map((label, index) => ({
        comparison: "aa", label, revision: BASELINE,
        rotation: (definition.baseRotation + index) % 8,
      }));
      const quartetOrder = quartetOrders[local];
      blocks.push({
        block: blocks.length, cohort, local, abPattern, aaPattern,
        baseRotation: definition.baseRotation, quartetOrder,
        processOrder: quartetOrder === "ab-first" ? [...ab, ...aa] : [...aa, ...ab],
      });
    }
  }
  assert.equal(blocks.length, sample.blocks);
  if (sample.blocksPerCohort === 12) {
    for (let cohort = 0; cohort < sample.cohorts; cohort += 1) {
      const cohortBlocks = blocks.filter((block) => block.cohort === cohort);
      assert.equal(cohortBlocks.filter(({ abPattern }) => abPattern === "ABBA").length, 6);
      assert.equal(cohortBlocks.filter(({ aaPattern }) => aaPattern === "A0A1A1A0").length, 6);
      assert.equal(cohortBlocks.filter(({ quartetOrder }) => quartetOrder === "ab-first").length, 6);
      for (const [comparison, labels] of [["ab", ["A", "B"]], ["aa", ["A0", "A1"]]]) {
        for (const label of labels) {
          const rotations = cohortBlocks.flatMap(({ processOrder }) => processOrder)
            .filter((entry) => entry.comparison === comparison && entry.label === label)
            .map(({ rotation }) => rotation);
          assert.deepEqual([...Array(8).keys()].map((rotation) =>
            rotations.filter((value) => value === rotation).length), Array(8).fill(3));
        }
      }
    }
  }
  return blocks;
}

function sanitizedSchedule(schedule) {
  return schedule.map((block) => ({ ...block, processOrder: block.processOrder.map((entry, slot) => ({
    slot, comparison: entry.comparison, label: entry.label,
    revision: entry.revision, rotation: entry.rotation,
  })) }));
}

async function spawnChild(configuration) {
  const encoded = Buffer.from(JSON.stringify(configuration)).toString("base64url");
  const environment = { ...process.env, FS_SAFE_NATIVE_MODE: "off", NODE_ENV: "production" };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_V8_COVERAGE;
  const started = process.hrtime.bigint();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], "--child-config", encoded], {
      env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes <= 32_768) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes <= 32_768) stderr.push(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, error: errorInfo(error), stdout, stderr,
        stdoutBytes, stderrBytes });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, stdoutBytes, stderrBytes });
    });
  });
  return {
    ...result, durationNs: Number(process.hrtime.bigint() - started),
    stdout: Buffer.concat(result.stdout).toString("utf8"),
    stderr: Buffer.concat(result.stderr).toString("utf8"),
  };
}

function aggregateBlocks(plan, receipts) {
  const grouped = new Map();
  for (const receipt of receipts) {
    for (const workload of receipt.workloads) {
      const key = `${receipt.block}:${workload.id}:${receipt.comparison}:${receipt.label}`;
      const childMeans = grouped.get(key) ?? [];
      childMeans.push(mean(workload.samplesNs));
      grouped.set(key, childMeans);
    }
  }
  const result = new Map(plan.workloads.map(({ id }) => [id, []]));
  for (let block = 0; block < Math.max(...receipts.map(({ block: value }) => value)) + 1; block += 1) {
    const cohort = receipts.find((receipt) => receipt.block === block)?.cohort;
    for (const workload of plan.workloads) {
      const get = (comparison, label) => grouped.get(`${block}:${workload.id}:${comparison}:${label}`) ?? [];
      const a = get("ab", "A");
      const b = get("ab", "B");
      const a0 = get("aa", "A0");
      const a1 = get("aa", "A1");
      assert.deepEqual([a.length, b.length, a0.length, a1.length], [2, 2, 2, 2]);
      const baselineNs = mean(a);
      const candidateNs = mean(b);
      const control0Ns = mean(a0);
      const control1Ns = mean(a1);
      result.get(workload.id).push({
        block, cohort, childMeansNs: { a, b, a0, a1 }, baselineNs, candidateNs, control0Ns, control1Ns,
        abLogRatio: Math.log(candidateNs / baselineNs), abDeltaNs: candidateNs - baselineNs,
        aaLogRatio: Math.log(control1Ns / control0Ns), aaDeltaNs: control1Ns - control0Ns,
      });
    }
  }
  return result;
}

function metricPoint(records, prefix) {
  const logRatio = median(records.map((record) => record[`${prefix}LogRatio`]));
  const deltaNs = median(records.map((record) => record[`${prefix}DeltaNs`]));
  return { logRatio, relativePercent: Math.expm1(logRatio) * 100,
    deltaNs, absoluteMicroseconds: deltaNs / 1_000 };
}

function bootstrapAll(blocks, plan, sample) {
  const random = xorshift32(plan.analysis.bootstrapSeed);
  const draws = new Map(plan.workloads.map(({ id }) => [id, {
    abLogRatio: [], abDeltaNs: [], aaLogRatio: [], aaDeltaNs: [],
  }]));
  for (let iteration = 0; iteration < sample.bootstrapIterations; iteration += 1) {
    const selected = [];
    for (let cohort = 0; cohort < sample.cohorts; cohort += 1) {
      const cohortSelections = [];
      while (cohortSelections.length < sample.blocksPerCohort) {
        const start = Math.floor(random() * sample.blocksPerCohort);
        for (let offset = 0; offset < plan.analysis.movingBlockLength &&
          cohortSelections.length < sample.blocksPerCohort; offset += 1) {
          cohortSelections.push((start + offset) % sample.blocksPerCohort);
        }
      }
      selected.push(cohortSelections);
    }
    for (const workload of plan.workloads) {
      const records = blocks.get(workload.id);
      const sampleRecords = selected.flatMap((indices, cohort) => {
        const cohortRecords = records.filter((record) => record.cohort === cohort);
        assert.equal(cohortRecords.length, sample.blocksPerCohort);
        return indices.map((index) => cohortRecords[index]);
      });
      const target = draws.get(workload.id);
      for (const key of Object.keys(target)) target[key].push(median(sampleRecords.map((record) => record[key])));
    }
  }
  return draws;
}

function confidence(values, transform = (value) => value) {
  const sorted = [...values].sort((left, right) => left - right);
  return { lower: transform(quantile(sorted, 0.025)), upper: transform(quantile(sorted, 0.975)) };
}

function classifyWorkload(records, draws, plan) {
  const relativeGate = plan.analysis.relativeRegressionPercent;
  const absoluteGate = plan.analysis.absoluteRegressionMicroseconds;
  const abRelative = confidence(draws.abLogRatio, (value) => Math.expm1(value) * 100);
  const abAbsolute = confidence(draws.abDeltaNs, (value) => value / 1_000);
  const aaRelative = confidence(draws.aaLogRatio, (value) => Math.expm1(value) * 100);
  const aaAbsolute = confidence(draws.aaDeltaNs, (value) => value / 1_000);
  const relativeContainsZero = aaRelative.lower <= 0 && aaRelative.upper >= 0;
  const absoluteContainsZero = aaAbsolute.lower <= 0 && aaAbsolute.upper >= 0;
  const relativeEquivalent = aaRelative.lower >= -relativeGate && aaRelative.upper <= relativeGate;
  const absoluteEquivalent = aaAbsolute.lower >= -absoluteGate && aaAbsolute.upper <= absoluteGate;
  const calibrated = relativeContainsZero && absoluteContainsZero &&
    (relativeEquivalent || absoluteEquivalent);
  const excludesRegression = abRelative.upper <= relativeGate || abAbsolute.upper <= absoluteGate;
  const provesRegression = abRelative.lower > relativeGate && abAbsolute.lower > absoluteGate;
  const classification = calibrated && excludesRegression ? "ACCEPT"
    : calibrated && provesRegression ? "REGRESSION" : "INCONCLUSIVE";
  return {
    classification,
    baselineMicroseconds: median(records.map(({ baselineNs }) => baselineNs)) / 1_000,
    candidateMicroseconds: median(records.map(({ candidateNs }) => candidateNs)) / 1_000,
    ab: { point: metricPoint(records, "ab"), confidenceInterval: {
      relativePercent: abRelative, absoluteMicroseconds: abAbsolute,
    }, excludesMaterialRegression: excludesRegression, provesMaterialRegression: provesRegression },
    aa: { point: metricPoint(records, "aa"), confidenceInterval: {
      relativePercent: aaRelative, absoluteMicroseconds: aaAbsolute,
    }, relativeContainsZero, absoluteContainsZero, relativeEquivalent, absoluteEquivalent, calibrated },
  };
}

function renderMarkdownReport(report) {
  const lines = [
    "# Producer-isolation paired Windows proof", "",
    `Classification: **${report.classification}**`, "",
    `Mode: ${report.mode}${report.notPerformanceEvidence ? " (structural smoke; not performance evidence)" : ""}`,
    `Fresh single-variant processes: ${report.freshProcesses}`,
    `Baseline: \`${report.revisions.baseline}\``, `Candidate: \`${report.revisions.candidate}\``, "",
  ];
  if (report.mode === "production") {
    lines.push("| Workload | Result | A/B point | A/B relative 95% CI | A/B absolute 95% CI | A/A calibrated |",
      "|---|---:|---:|---:|---:|---:|");
    for (const result of report.results) {
      const relative = result.ab.confidenceInterval.relativePercent;
      const absolute = result.ab.confidenceInterval.absoluteMicroseconds;
      lines.push(`| ${result.workload} | ${result.classification} | ${result.ab.point.relativePercent.toFixed(3)}% / ${result.ab.point.absoluteMicroseconds.toFixed(3)} µs | [${relative.lower.toFixed(3)}, ${relative.upper.toFixed(3)}]% | [${absolute.lower.toFixed(3)}, ${absolute.upper.toFixed(3)}] µs | ${result.aa.calibrated} |`);
    }
  } else {
    lines.push("| Workload | A/B point | A/A point |", "|---|---:|---:|");
    for (const result of report.results) lines.push(`| ${result.workload} | ${result.ab.point.relativePercent.toFixed(3)}% | ${result.aa.point.relativePercent.toFixed(3)}% |`);
  }
  lines.push("", ...report.interpretation.map((line) => `- ${line}`), "");
  return `${lines.join("\n")}\n`;
}

async function childMain(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const receipt = {
    schema: 1, passed: false, launchOrdinal: config.launchOrdinal,
    block: config.block, cohort: config.cohort, slot: config.slot,
    comparison: config.comparison, label: config.label, revision: config.revision,
    workloadRotation: config.rotation, nativeMode: process.env.FS_SAFE_NATIVE_MODE,
    runtime: { node: process.version, platform: process.platform, arch: process.arch,
      pid: process.pid, executableSha256: fileSha256(process.execPath) },
    startedAt: new Date().toISOString(), startResourceUsage: process.resourceUsage(),
    nativeLoads: [], nativeLoaderCalls: 0, workloads: [],
  };
  let originalNodeExtension;
  let resetNativeConfig;
  let resetNativeLoader;
  try {
    assert.equal(process.env.FS_SAFE_NATIVE_MODE, "off");
    assert.equal(receipt.runtime.node, config.expectedRuntime.node);
    assert.equal(receipt.runtime.platform, config.expectedRuntime.platform);
    assert.equal(receipt.runtime.arch, config.expectedRuntime.arch);
    assert.equal(receipt.runtime.executableSha256, config.expectedRuntime.executableSha256);
    assert.equal(receipt.nativeMode, config.expectedRuntime.nativeMode);
    assert.equal(config.revision, ["A", "A0", "A1"].includes(config.label) ? BASELINE : CANDIDATE);
    const manifestPath = path.join(config.fixtureDir, "manifest.json");
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8"));
    receipt.fixtureManifestSha256 = fileSha256(manifestPath);
    receipt.fixtureHashesBefore = fixtureHashes(config.fixtureDir, manifest);
    const require = createRequire(pathToFileURL(path.join(config.repoDir, "package.json")));
    assert.deepEqual(Object.values(require.cache).filter((entry) => entry?.filename?.endsWith(".node")), []);
    originalNodeExtension = Module._extensions?.[".node"];
    if (originalNodeExtension) {
      Module._extensions[".node"] = (_commonJsModule, filename) => {
        receipt.nativeLoads.push(path.basename(filename));
        throw new Error(`native addon load forbidden: ${path.basename(filename)}`);
      };
    }
    const advanced = await import(pathToFileURL(path.join(config.repoDir, "dist/advanced.js")).href);
    const output = await import(pathToFileURL(path.join(config.repoDir, "dist/output.js")).href);
    const nativeConfig = await import(pathToFileURL(path.join(config.repoDir, "dist/native-config.js")).href);
    const native = await import(pathToFileURL(path.join(config.repoDir, "dist/native.js")).href);
    resetNativeConfig = nativeConfig.__resetFsSafeNativeConfigForTest;
    resetNativeLoader = native.__resetNativeLoaderForTest;
    nativeConfig.configureFsSafeNative({ mode: "off" });
    native.__setNativeLoaderForTest(() => {
      receipt.nativeLoaderCalls += 1;
      throw new Error("native loader invoked while mode is off");
    });
    assert.equal(nativeConfig.getFsSafeNativeConfig().mode, "off");
    assert.equal(native.getNativeBinding(), undefined);

    const childRoot = path.join(config.workDir, `child-${String(config.launchOrdinal).padStart(3, "0")}`);
    await fs.mkdir(childRoot);
    const payloads = new Map(Object.entries(manifest.payloads).map(([size, definition]) => {
      const payload = fsSync.readFileSync(path.join(config.fixtureDir, definition.file));
      assert.equal(payload.length, definition.bytes);
      assert.equal(sha256(payload), definition.sha256);
      return [size, payload];
    }));
    const workloads = [];
    for (const workload of config.workloads) {
      const workloadDir = path.join(childRoot, workload.id.replaceAll("/", "-"));
      await fs.mkdir(workloadDir);
      const finalPath = path.join(workloadDir, "final.bin");
      const payload = payloads.get(String(workload.payloadBytes));
      const samplesNs = [];
      const positions = [];
      const rounds = [];
      let verifiedCalls = 0;
      let writerCalls = 0;
      let resolverCalls = 0;
      let cleanupChecks = 0;
      workloads.push({
        ...workload, samplesNs, positions, rounds,
        async once(timed, position, round) {
          let producedPath;
          let writerReceiver;
          let resolverReceiver;
          let resolverResult;
          const resultToken = { workload: workload.id, call: verifiedCalls };
          const writer = async function (pathname) {
            writerCalls += 1;
            producedPath = pathname;
            writerReceiver = this;
            await fs.writeFile(pathname, payload, { flag: "wx", mode: 0o600 });
            return resultToken;
          };
          const resolver = function (result) {
            resolverCalls += 1;
            resolverReceiver = this;
            resolverResult = result;
            return finalPath;
          };
          const isolation = workload.isolation === "private" ? "private-directory" : undefined;
          const options = workload.api === "sibling" ? {
            dir: workloadDir, chmodDir: false, writeTemp: writer,
            resolveFinalPath: resolver, producerIsolation: isolation,
          } : {
            rootDir: workloadDir, path: "final.bin", staging: "sibling",
            write: writer, producerIsolation: isolation,
          };
          const run = workload.api === "sibling"
            ? () => advanced.writeSiblingTempFile(options)
            : () => output.writeExternalFileWithinRoot(options);
          const started = process.hrtime.bigint();
          const result = await run();
          const finished = process.hrtime.bigint();
          if (timed) {
            const durationNs = Number(finished - started);
            assert(Number.isFinite(durationNs) && durationNs > 0);
            samplesNs.push(durationNs);
            positions.push(position);
            rounds.push(round);
          }
          assert.equal(path.resolve(result.filePath ?? result.path), finalPath);
          assert.equal(result.result, resultToken);
          assert.equal(resolverResult, workload.api === "sibling" ? resultToken : undefined);
          assert.equal(writerCalls, verifiedCalls + 1);
          assert.equal(resolverCalls, workload.api === "sibling" ? verifiedCalls + 1 : 0);
          assert(writerReceiver && writerReceiver !== options);
          const outerReceiver = Object.hasOwn(writerReceiver, "resolveFinalPath") &&
            Object.hasOwn(writerReceiver, "syncTempFile");
          const oldPrivateSemantics = config.revision === BASELINE && workload.isolation === "private";
          assert.equal(outerReceiver, !oldPrivateSemantics);
          if (workload.api === "sibling") {
            assert(resolverReceiver && resolverReceiver !== options);
            assert.equal(writerReceiver === resolverReceiver, !oldPrivateSemantics);
          }
          if (workload.isolation === "direct") {
            assert.equal(path.dirname(producedPath), workloadDir);
          } else {
            assert.notEqual(path.dirname(producedPath), workloadDir);
            assert.equal(path.dirname(path.dirname(producedPath)), workloadDir);
          }
          assert.equal(sha256(await fs.readFile(finalPath)), manifest.payloads[String(workload.payloadBytes)].sha256);
          await assert.rejects(fs.lstat(producedPath), { code: "ENOENT" });
          await fs.unlink(finalPath);
          assert.deepEqual(await fs.readdir(workloadDir), []);
          cleanupChecks += 1;
          verifiedCalls += 1;
        },
        summary() { return { verifiedCalls, writerCalls, resolverCalls, cleanupChecks }; },
      });
    }
    const roundOrder = (round) => workloads.map((_unused, index) =>
      workloads[(index + config.rotation + round) % workloads.length]);
    receipt.warmupRoundOrders = [];
    receipt.timedRoundOrders = [];
    for (let round = 0; round < config.warmupCalls; round += 1) {
      const order = roundOrder(round);
      receipt.warmupRoundOrders.push(order.map(({ id }) => id));
      for (const [position, workload] of order.entries()) await workload.once(false, position, round);
    }
    for (let round = 0; round < config.timedCalls; round += 1) {
      const order = roundOrder(round);
      receipt.timedRoundOrders.push(order.map(({ id }) => id));
      for (const [position, workload] of order.entries()) await workload.once(true, position, round);
    }
    receipt.workloads = workloads.map((workload, planOrder) => ({
      id: workload.id, planOrder, warmupCalls: config.warmupCalls, timedCalls: config.timedCalls,
      samplesNs: workload.samplesNs, timedPositions: workload.positions, timedRounds: workload.rounds,
      validation: workload.summary(),
    }));
    await fs.rm(childRoot, { recursive: true });
    await assert.rejects(fs.lstat(childRoot), { code: "ENOENT" });
    receipt.childWorkspaceRemoved = true;
    receipt.fixtureHashesAfter = fixtureHashes(config.fixtureDir, manifest);
    assert.deepEqual(receipt.fixtureHashesAfter, receipt.fixtureHashesBefore);
    assert.equal(fileSha256(manifestPath), receipt.fixtureManifestSha256);
    assert.equal(native.getNativeBinding(), undefined);
    assert.equal(nativeConfig.getFsSafeNativeConfig().mode, "off");
    assert.equal(receipt.nativeLoaderCalls, 0);
    assert.deepEqual(receipt.nativeLoads, []);
    assert.deepEqual(Object.values(require.cache).filter((entry) => entry?.filename?.endsWith(".node")), []);
    receipt.passed = true;
  } catch (error) {
    receipt.error = errorInfo(error);
  } finally {
    try { resetNativeLoader?.(); } catch (error) { receipt.resetNativeLoaderError = errorInfo(error); }
    try { resetNativeConfig?.(); } catch (error) { receipt.resetNativeConfigError = errorInfo(error); }
    if (originalNodeExtension) Module._extensions[".node"] = originalNodeExtension;
    receipt.finishedAt = new Date().toISOString();
    receipt.endResourceUsage = process.resourceUsage();
    receipt.passed = receipt.passed && !receipt.resetNativeLoaderError && !receipt.resetNativeConfigError;
    writeAtomic(config.receiptPath, receipt);
  }
  if (!receipt.passed) process.exitCode = 1;
}

async function orchestratorMain(values) {
  assert(["production", "smoke"].includes(values.mode), "--mode must be production or smoke");
  assert(values.plan && values["baseline-dir"] && values["candidate-dir"] && values.output,
    "required: --plan --baseline-dir --candidate-dir --output");
  const mode = values.mode;
  const output = path.resolve(values.output);
  fsSync.mkdirSync(output);
  const progress = { schema: 1, mode, notPerformanceEvidence: mode === "smoke", passed: false,
    classification: "INCOMPLETE", startedAt: new Date().toISOString() };
  writeExclusive(path.join(output, "progress.json"), progress);
  try {
    const planPath = path.resolve(values.plan);
    const harnessPath = fsSync.realpathSync(process.argv[1]);
    const { plan, digest: planSha256, rawDigest: planRawSha256 } = validatePlan(planPath, mode);
    const repositories = validateRepositories(plan, values["baseline-dir"], values["candidate-dir"], mode);
    const sample = mode === "production" ? {
      blocks: plan.sampling.blocks, cohorts: plan.sampling.cohorts,
      blocksPerCohort: plan.sampling.blocksPerCohort,
      warmupCallsPerWorkload: plan.sampling.warmupCallsPerWorkload,
      timedCallsPerWorkload: plan.sampling.timedCallsPerWorkload,
      bootstrapIterations: plan.analysis.bootstrapIterations,
    } : SMOKE;
    assert.equal(sample.blocks, sample.cohorts * sample.blocksPerCohort);
    const proofRoot = path.dirname(path.dirname(output));
    const fixtureDir = path.join(proofRoot, "producer-isolation-fixtures");
    const workDir = path.join(proofRoot, "producer-isolation-workspaces");
    const childReceiptDir = path.join(output, "child-receipts");
    const privateFixtureManifest = path.join(fixtureDir, "manifest.json");
    const evidencePlan = path.join(output, "plan.json");
    const evidenceFixtureManifest = path.join(output, "fixture-manifest.json");
    fsSync.mkdirSync(childReceiptDir);
    fsSync.mkdirSync(workDir);
    fsSync.copyFileSync(planPath, evidencePlan, fsSync.constants.COPYFILE_EXCL);
    const manifest = createFixtures(fixtureDir, plan.workloads);
    fsSync.copyFileSync(privateFixtureManifest, evidenceFixtureManifest, fsSync.constants.COPYFILE_EXCL);
    const buildInputsBefore = {
      baseline: fingerprintBuildInputs(repositories.baseline),
      candidate: fingerprintBuildInputs(repositories.candidate),
    };
    const fingerprintsBefore = {
      baseline: await fingerprintRepository(repositories.baseline),
      candidate: await fingerprintRepository(repositories.candidate),
    };
    assert.equal(fingerprintsBefore.baseline.files["pnpm-lock.yaml"],
      fingerprintsBefore.candidate.files["pnpm-lock.yaml"], "dependency lockfiles differ");
    const sourceTrees = {
      baseline: git(repositories.baseline, ["rev-parse", "HEAD^{tree}"]),
      candidate: git(repositories.candidate, ["rev-parse", "HEAD^{tree}"]),
    };
    const productionShape = { blocks: plan.sampling.blocks, cohorts: plan.sampling.cohorts,
      blocksPerCohort: plan.sampling.blocksPerCohort };
    const productionSchedule = buildSchedule(plan, productionShape);
    const productionScheduleSha256 = sha256(json(sanitizedSchedule(productionSchedule)));
    const schedule = mode === "production" ? productionSchedule : buildSchedule(plan, sample);
    writeExclusive(path.join(output, "schedule.json"), {
      schema: 1, mode, scheduleSeed: plan.sampling.scheduleSeed,
      latinRotation: plan.sampling.workloadRotation, blocks: sanitizedSchedule(schedule),
    });
    const integrityBefore = {
      harnessRawSha256: fileSha256(harnessPath), planRawSha256: fileSha256(planPath),
      evidencePlanRawSha256: fileSha256(evidencePlan),
      privateFixtureManifestSha256: fileSha256(privateFixtureManifest),
      evidenceFixtureManifestSha256: fileSha256(evidenceFixtureManifest),
    };
    assert.equal(integrityBefore.planRawSha256, integrityBefore.evidencePlanRawSha256);
    assert.equal(integrityBefore.privateFixtureManifestSha256,
      integrityBefore.evidenceFixtureManifestSha256);
    const expectedChildRuntime = { node: process.version, platform: process.platform,
      arch: process.arch, executableSha256: fileSha256(process.execPath), nativeMode: "off" };
    writeExclusive(path.join(output, "preflight.json"), {
      schema: 1, mode, notPerformanceEvidence: mode === "smoke", planSha256, planRawSha256,
      harnessSha256: integrityBefore.harnessRawSha256, revisions: plan.revisions,
      runtime: { node: process.version, versions: process.versions, platform: process.platform,
        arch: process.arch, executableSha256: expectedChildRuntime.executableSha256,
        cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null,
        totalMemoryBytes: os.totalmem(), runnerImage: {
          os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null,
        } },
      sample, fixedProductionSample: plan.sampling, fixedAnalysis: plan.analysis,
      fingerprintsBefore, buildInputsBefore, checkoutCleanlinessBefore: repositories.cleanliness,
      sourceTrees, productionScheduleSha256, integrityBefore,
      fixtureHashesBefore: fixtureHashes(fixtureDir, manifest),
      interpretation: [
        "Smoke mode is structural self-test only and cannot change production plan values.",
        "Each child loads one revision only and times complete public calls with payloads and fixture directories prepared first.",
        "Result identity, content, callback receiver, staging location, and cleanup are validated outside timing.",
        "All samples are fresh and retained; no old evidence, retry, filtering, pooling, or adaptive extension is used.",
        "FS_SAFE_NATIVE_MODE=off is configured and asserted; loader and .node tripwires must remain untouched.",
      ],
    });

    const receipts = [];
    const launches = [];
    const telemetry = [snapshotSystem("before-proof", fixtureDir)];
    writeExclusive(path.join(output, "telemetry.json"), { schema: 1, snapshots: telemetry });
    writeExclusive(path.join(output, "launches.json"), { schema: 1, launches });
    let launchOrdinal = 0;
    for (const block of schedule) {
      if (block.local === 0) telemetry.push(snapshotSystem(`cohort-${block.cohort}-start`, fixtureDir));
      telemetry.push(snapshotSystem(`block-${block.block}-start`, fixtureDir));
      writeAtomic(path.join(output, "telemetry.json"), { schema: 1, snapshots: telemetry });
      for (const [slot, processPlan] of block.processOrder.entries()) {
        const receiptName = `child-${String(launchOrdinal).padStart(3, "0")}.json`;
        const receiptPath = path.join(childReceiptDir, receiptName);
        const repoDir = processPlan.revision === BASELINE ? repositories.baseline : repositories.candidate;
        const configuration = {
          repoDir, fixtureDir, workDir, receiptPath, workloads: plan.workloads,
          warmupCalls: sample.warmupCallsPerWorkload,
          timedCalls: sample.timedCallsPerWorkload,
          launchOrdinal, block: block.block, cohort: block.cohort, slot,
          comparison: processPlan.comparison, label: processPlan.label,
          revision: processPlan.revision, rotation: processPlan.rotation,
          expectedRuntime: expectedChildRuntime,
        };
        const launched = await spawnChild(configuration);
        const launch = {
          launchOrdinal, block: block.block, cohort: block.cohort, slot,
          comparison: processPlan.comparison, label: processPlan.label,
          revision: processPlan.revision, rotation: processPlan.rotation,
          receipt: `child-receipts/${receiptName}`, code: launched.code,
          signal: launched.signal, timedOut: launched.timedOut, durationNs: launched.durationNs,
          stdoutBytes: launched.stdoutBytes, stderrBytes: launched.stderrBytes, error: launched.error,
        };
        if (launched.stdout) launch.stdout = launched.stdout;
        if (launched.stderr) launch.stderr = launched.stderr;
        launches.push(launch);
        writeAtomic(path.join(output, "launches.json"), { schema: 1, launches });
        if (launched.code !== 0 || launched.signal || launched.timedOut || !fsSync.existsSync(receiptPath)) {
          throw new Error(`child ${launchOrdinal} failed: ${launched.code}/${launched.signal ?? "none"}`);
        }
        const receipt = JSON.parse(fsSync.readFileSync(receiptPath, "utf8"));
        assert.equal(receipt.passed, true, `child ${launchOrdinal} receipt failed`);
        receipts.push(receipt);
        launchOrdinal += 1;
      }
      telemetry.push(snapshotSystem(`block-${block.block}-end`, fixtureDir));
      if (block.local === sample.blocksPerCohort - 1) {
        telemetry.push(snapshotSystem(`cohort-${block.cohort}-end`, fixtureDir));
      }
      writeAtomic(path.join(output, "telemetry.json"), { schema: 1, snapshots: telemetry });
      writeAtomic(path.join(output, "progress.json"), {
        ...progress, completedBlocks: block.block + 1, completedFreshProcesses: launchOrdinal,
      });
    }
    telemetry.push(snapshotSystem("after-proof", fixtureDir));
    writeAtomic(path.join(output, "telemetry.json"), { schema: 1, snapshots: telemetry });
    const expectedProcesses = sample.blocks * plan.sampling.processesPerBlock;
    assert.equal(receipts.length, expectedProcesses);
    if (mode === "production") assert.equal(receipts.length, plan.sampling.expectedFreshProcesses);
    assert(receipts.every((receipt) => receipt.workloads.length === 8 && receipt.childWorkspaceRemoved));
    assert(receipts.every((receipt) => receipt.runtime.node === expectedChildRuntime.node &&
      receipt.runtime.platform === expectedChildRuntime.platform &&
      receipt.runtime.arch === expectedChildRuntime.arch &&
      receipt.runtime.executableSha256 === expectedChildRuntime.executableSha256 &&
      receipt.nativeMode === expectedChildRuntime.nativeMode));
    assert(receipts.every((receipt) => receipt.workloads.every((workload) =>
      workload.warmupCalls === sample.warmupCallsPerWorkload &&
      workload.timedCalls === sample.timedCallsPerWorkload &&
      workload.samplesNs.length === sample.timedCallsPerWorkload &&
      workload.validation.verifiedCalls === sample.warmupCallsPerWorkload + sample.timedCallsPerWorkload &&
      workload.validation.cleanupChecks === workload.validation.verifiedCalls)));
    if (mode === "production") {
      const workloadIds = plan.workloads.map(({ id }) => id);
      for (const receipt of receipts) {
        for (const orders of [receipt.warmupRoundOrders, receipt.timedRoundOrders]) {
          assert.equal(orders.length, 16);
          assert(orders.every((order) => order.length === 8 &&
            [...order].sort().join("\0") === [...workloadIds].sort().join("\0")));
          for (const workloadId of workloadIds) {
            const positions = orders.map((order) => order.indexOf(workloadId));
            assert.deepEqual([...Array(8).keys()].map((position) =>
              positions.filter((value) => value === position).length), Array(8).fill(2));
          }
        }
      }
    }
    assert.deepEqual(await fs.readdir(workDir), [], "child workspace root retained entries");
    const rawSamples = receipts.flatMap((receipt) => receipt.workloads.flatMap((workload) =>
      workload.samplesNs.map((durationNs, sampleIndex) => ({
        launchOrdinal: receipt.launchOrdinal, block: receipt.block, cohort: receipt.cohort,
        comparison: receipt.comparison, label: receipt.label, revision: receipt.revision,
        rotation: receipt.workloadRotation, workload: workload.id,
        workloadPosition: workload.timedPositions[sampleIndex], round: workload.timedRounds[sampleIndex],
        sampleIndex, durationNs,
      }))));
    writeExclusive(path.join(output, "raw-samples.json"), { schema: 1, samples: rawSamples });
    const blocks = aggregateBlocks(plan, receipts);
    writeExclusive(path.join(output, "block-estimates.json"), {
      schema: 1, workloads: Object.fromEntries(blocks),
    });
    const results = [];
    if (mode === "production") {
      const draws = bootstrapAll(blocks, plan, sample);
      for (const workload of plan.workloads) results.push({ workload: workload.id,
        ...classifyWorkload(blocks.get(workload.id), draws.get(workload.id), plan) });
    } else {
      for (const workload of plan.workloads) {
        const records = blocks.get(workload.id);
        results.push({ workload: workload.id, classification: "SMOKE_ONLY",
          ab: { point: metricPoint(records, "ab") }, aa: { point: metricPoint(records, "aa") } });
      }
    }
    const fingerprintsAfter = {
      baseline: await fingerprintRepository(repositories.baseline),
      candidate: await fingerprintRepository(repositories.candidate),
    };
    const buildInputsAfter = {
      baseline: fingerprintBuildInputs(repositories.baseline),
      candidate: fingerprintBuildInputs(repositories.candidate),
    };
    const checkoutCleanlinessAfter = {
      baseline: assertRepositoryInputsClean(repositories.baseline),
      candidate: assertRepositoryInputsClean(repositories.candidate),
    };
    const integrityAfter = {
      harnessRawSha256: fileSha256(harnessPath), planRawSha256: fileSha256(planPath),
      evidencePlanRawSha256: fileSha256(evidencePlan),
      privateFixtureManifestSha256: fileSha256(privateFixtureManifest),
      evidenceFixtureManifestSha256: fileSha256(evidenceFixtureManifest),
    };
    const fixtureHashesAfter = fixtureHashes(fixtureDir, manifest);
    assert.deepEqual(fingerprintsAfter, fingerprintsBefore, "built revisions changed during proof");
    assert.deepEqual(buildInputsAfter, buildInputsBefore, "source or build inputs changed during proof");
    assert.deepEqual(integrityAfter, integrityBefore, "harness, plan, or fixture manifest changed during proof");
    assert.deepEqual(fixtureHashesAfter,
      Object.fromEntries(Object.entries(manifest.files).map(([name, entry]) => [name, entry.sha256])),
      "payload fixtures changed during proof");
    const classification = mode === "smoke" ? "SMOKE_ONLY"
      : results.every((result) => result.classification === "ACCEPT") ? "ACCEPT"
        : results.some((result) => result.classification === "REGRESSION") ? "REGRESSION" : "INCONCLUSIVE";
    const report = {
      schema: 1, mode, notPerformanceEvidence: mode === "smoke", classification,
      passed: mode === "smoke" || classification === "ACCEPT", revisions: plan.revisions,
      planSha256, planRawSha256, scheduleSeed: plan.sampling.scheduleSeed,
      bootstrapSeed: plan.analysis.bootstrapSeed, freshProcesses: receipts.length, sample,
      thresholds: { relativeRegressionPercent: plan.analysis.relativeRegressionPercent,
        absoluteRegressionMicroseconds: plan.analysis.absoluteRegressionMicroseconds },
      bootstrap: mode === "production" ? { iterations: plan.analysis.bootstrapIterations,
        movingBlockLength: plan.analysis.movingBlockLength, stratification: plan.analysis.stratification,
        pairedAbAndAaIndices: true, intervalsAreMarginalPerWorkload: true } : null,
      interpretation: mode === "production" ? [
        "All timing samples and children are new and retained; arithmetic child means are equal-weighted within each arm.",
        "Every one of the eight workload classifications must be ACCEPT.",
        "Acceptance is evidence against the defined dual-threshold regression on this hosted Windows environment, not universal proof of zero slowdown.",
      ] : ["Structural smoke only; timing values are not performance evidence."],
      results, fixtureHashesAfter, fingerprintsAfter, buildInputsAfter,
      checkoutCleanlinessAfter, integrityAfter, finishedAt: new Date().toISOString(),
    };
    writeExclusive(path.join(output, "report.json"), report);
    fsSync.writeFileSync(path.join(output, "report.md"), renderMarkdownReport(report), {
      flag: "wx", mode: 0o600,
    });
    writeAtomic(path.join(output, "progress.json"), report);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const failure = { ...progress, error: errorInfo(error), finishedAt: new Date().toISOString() };
    writeAtomic(path.join(output, "progress.json"), failure);
    if (!fsSync.existsSync(path.join(output, "report.json"))) writeExclusive(path.join(output, "report.json"), failure);
    throw error;
  }
}

const { values } = parseArgs({
  options: {
    mode: { type: "string" }, plan: { type: "string" },
    "baseline-dir": { type: "string" }, "candidate-dir": { type: "string" },
    output: { type: "string" }, "child-config": { type: "string" },
  },
  strict: true,
});

try {
  if (values["child-config"]) await childMain(values["child-config"]);
  else await orchestratorMain(values);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
