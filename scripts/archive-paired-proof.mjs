#!/usr/bin/env node
// Frozen paired proof for PR #323. Production sample counts and gates come from
// the committed plan and cannot be overridden by arguments or environment.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BASELINE = "49e78da32cdac9714417b735ab2f50bfc1392ec8";
const CANDIDATE = "1d1dda92fcea8c5aa7f9fb05d974007e25a3967e";
const PLAN_SHA256 = "de66f6910aef46b6192ec19a5b36fde8dd23810d0508030a3943335d838ec77f";
const CHILD_TIMEOUT_MS = 120_000;
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

function median(values) {
  assert(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values) {
  assert(values.length > 0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted, probability) {
  const offset = (sorted.length - 1) * probability;
  const lower = Math.floor(offset);
  const fraction = offset - lower;
  return sorted[lower] + (sorted[lower + 1] === undefined
    ? 0
    : fraction * (sorted[lower + 1] - sorted[lower]));
}

async function createFixtures(fixtureDir, workloads, dependencyRepo) {
  fsSync.mkdirSync(fixtureDir);
  // This is the selected subset of benchmarks/archives.mjs. Its source hash is
  // required to match between the two frozen revisions before sampling.
  const require = createRequire(path.join(dependencyRepo, "package.json"));
  const tar = require("tar");
  const manySource = path.join(fixtureDir, "tar-many-source");
  fsSync.mkdirSync(manySource);
  const names = Array.from({ length: 512 }, (_unused, index) => `entry-${index}`);
  const memberPayload = Buffer.alloc(64, 42);
  for (const name of names) fsSync.writeFileSync(path.join(manySource, name), memberPayload);
  const manyGzip = path.join(fixtureDir, "many.tgz");
  await tar.c({ cwd: manySource, file: manyGzip, portable: true, gzip: true }, names);

  const payload1MiB = Buffer.alloc(1024 * 1024, 0x61);
  const largeSource = path.join(fixtureDir, "tar-source-1048576");
  fsSync.mkdirSync(largeSource);
  fsSync.writeFileSync(path.join(largeSource, "payload.bin"), payload1MiB);
  const largeTar = path.join(fixtureDir, "large-1048576.tar");
  const largeGzip = path.join(fixtureDir, "large-1048576.tgz");
  await tar.c({ cwd: largeSource, file: largeTar, portable: true, gzip: false }, ["payload.bin"]);
  await tar.c({ cwd: largeSource, file: largeGzip, portable: true, gzip: true }, ["payload.bin"]);

  const fixtureFiles = Object.fromEntries(["many.tgz", "large-1048576.tar", "large-1048576.tgz"]
    .map((name) => [name, {
      bytes: fsSync.statSync(path.join(fixtureDir, name)).size,
      sha256: fileSha256(path.join(fixtureDir, name)),
    }]));
  const manifest = {
    schema: 1,
    fixtureDefinition: "exact selected closures from benchmarks/archives.mjs",
    expectedManifests: {
      "inspectTarArchive/gzip-512-members": names.map((name) => ({
        path: name,
        kind: "file",
        size: memberPayload.length,
      })),
    },
    payloads: {
      "64": {
        bytes: memberPayload.length,
        fillByte: 42,
        sha256: sha256(memberPayload),
        fullBase64: memberPayload.toString("base64"),
      },
      "1048576": {
        bytes: payload1MiB.length,
        fillByte: 97,
        sha256: sha256(payload1MiB),
      },
    },
    files: fixtureFiles,
    workloadIds: workloads.map(({ id }) => id),
  };
  writeExclusive(path.join(fixtureDir, "manifest.json"), manifest);
  return manifest;
}

function validatePlan(planPath, mode) {
  const bytes = fsSync.readFileSync(planPath);
  const rawDigest = sha256(bytes);
  const plan = JSON.parse(bytes);
  const digest = sha256(json(plan));
  assert.equal(digest, PLAN_SHA256, "production plan semantics changed without updating the frozen harness");
  assert.equal(plan.revisions.baseline, BASELINE);
  assert.equal(plan.revisions.candidate, CANDIDATE);
  assert.equal(plan.runtime.node, "22.23.2");
  assert.equal(plan.runtime.pnpm, "11.25.0");
  assert.equal(plan.runtime.nativeMode, "off");
  assert.equal(plan.sampling.blocks, 48);
  assert.equal(plan.sampling.expectedFreshProcesses, 384);
  assert.equal(plan.sampling.processesPerBlock, 8);
  assert.equal(plan.sampling.warmupCallsPerWorkload, 16);
  assert.equal(plan.sampling.timedCallsPerWorkload, 16);
  assert.deepEqual(plan.sampling.abPatterns, ["ABBA", "BAAB"]);
  assert.deepEqual(plan.sampling.aaPatterns, ["A0A1A1A0", "A1A0A0A1"]);
  assert.equal(plan.sampling.aaRevision, "baseline");
  assert.equal(plan.workloads.length, 4);
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
  const output = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return output.split("\0").filter(Boolean).sort();
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
    "src",
    "archive-core",
    "archive-wasm",
    "scripts/build-archive-wasm.mjs",
    "scripts/prepack-build.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "Cargo.toml",
    "Cargo.lock",
  ];
  const names = gitNames(repo, ["ls-files", "-z", "--", ...selectors]);
  const files = Object.fromEntries(names.map((name) => [name, fileSha256(path.join(repo, name))]));
  return { files, manifestSha256: sha256(json(files)) };
}

function validateRepositories(plan, baselineDir, candidateDir, mode) {
  const baseline = fsSync.realpathSync(baselineDir);
  const candidate = fsSync.realpathSync(candidateDir);
  assert(fsSync.statSync(path.join(baseline, "dist/archive.js")).isFile(), "baseline is not built");
  assert(fsSync.statSync(path.join(candidate, "dist/archive.js")).isFile(), "candidate is not built");
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

async function fingerprintRepository(repo) {
  const fixed = [
    "package.json",
    "pnpm-lock.yaml",
    "benchmarks/archives.mjs",
    "src/archive-read.ts",
    "src/archive-tar-inspect.ts",
    "src/windows-path-alias.ts",
    "dist/archive-read.js",
    "dist/archive-tar-inspect.js",
    "dist/archive-parser.wasm",
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
  return { files, missing, manifestSha256: sha256(json({ files, missing })) };
}

function validateWasmAbi(repo) {
  const file = path.join(repo, "dist/archive-parser.wasm");
  const bytes = fsSync.readFileSync(file);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const instance = new WebAssembly.Instance(module);
  const exported = instance.exports;
  assert.deepEqual(imports, [], "archive WASM must not import host functions");
  assert.equal(typeof exported.push, "function");
  assert.equal(exported.push.length, 2, "archive WASM push ABI must accept offset and length");
  assert.equal(typeof exported.init, "function");
  assert.equal(exported.init.length, 5, "archive WASM init ABI changed");
  assert.equal(typeof exported.dispose, "function");
  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    imports,
    exportArities: { push: exported.push.length, init: exported.init.length },
  };
}

function snapshotSystem(label, directory) {
  const cpus = os.cpus();
  const disk = typeof fsSync.statfsSync === "function" ? fsSync.statfsSync(directory) : null;
  return {
    label,
    wallTime: new Date().toISOString(),
    monotonicNs: process.hrtime.bigint(),
    uptimeSeconds: os.uptime(),
    loadAverage: os.loadavg(),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
    processResourceUsage: process.resourceUsage(),
    cpuTimes: cpus.map(({ speed, times }) => ({ speed, times })),
    disk: disk ? {
      blockSize: disk.bsize,
      blocks: disk.blocks,
      freeBlocks: disk.bfree,
      availableBlocks: disk.bavail,
      files: disk.files,
      freeFiles: disk.ffree,
    } : null,
  };
}

function buildSchedule(plan, sample) {
  const random = xorshift32(plan.sampling.scheduleSeed);
  const blocks = [];
  for (let cohort = 0; cohort < sample.cohorts; cohort += 1) {
    const count = sample.blocksPerCohort;
    assert(count === 1 || count === 12, "only the frozen production or structural smoke schedule is allowed");
    const half = Math.floor(count / 2);
    const quartetOrders = shuffle([...Array(half).fill("ab-first"),
      ...Array(count - half).fill("aa-first")], random);
    const definitions = [];
    if (count === 1) {
      definitions.push({ baseRotation: 0, abChoice: 0, aaChoice: 0 });
    } else {
      // Opposite orientations share a base rotation. This makes label × Latin
      // start-position counts exactly equal within every chronological cohort.
      const pairBases = shuffle([0, 1, 2, 3, cohort % 4, (cohort + 1) % 4], random);
      const pairs = pairBases.map((baseRotation) => {
        const abFirst = random() < 0.5 ? 0 : 1;
        const aaFirst = random() < 0.5 ? 0 : 1;
        return random() < 0.5 ? [
          { baseRotation, abChoice: abFirst, aaChoice: aaFirst },
          { baseRotation, abChoice: 1 - abFirst, aaChoice: 1 - aaFirst },
        ] : [
          { baseRotation, abChoice: 1 - abFirst, aaChoice: 1 - aaFirst },
          { baseRotation, abChoice: abFirst, aaChoice: aaFirst },
        ];
      });
      definitions.push(...shuffle(pairs, random).flat());
    }
    for (let local = 0; local < count; local += 1) {
      const block = blocks.length;
      const { baseRotation, abChoice, aaChoice } = definitions[local];
      const abPattern = plan.sampling.abPatterns[abChoice];
      const aaPattern = plan.sampling.aaPatterns[aaChoice];
      const ab = [...abPattern].map((label, index) => ({
        comparison: "ab",
        label,
        revision: label === "A" ? BASELINE : CANDIDATE,
        rotation: (baseRotation + index) % 4,
      }));
      const aaLabels = aaPattern === "A0A1A1A0"
        ? ["A0", "A1", "A1", "A0"]
        : ["A1", "A0", "A0", "A1"];
      const aa = aaLabels.map((label, index) => ({
        comparison: "aa",
        label,
        revision: BASELINE,
        rotation: (baseRotation + index) % 4,
      }));
      const processOrder = quartetOrders[local] === "ab-first" ? [...ab, ...aa] : [...aa, ...ab];
      blocks.push({ block, cohort, local, abPattern, aaPattern, baseRotation,
        quartetOrder: quartetOrders[local], processOrder });
    }
  }
  assert.equal(blocks.length, sample.blocks);
  if (sample.blocksPerCohort === 12) {
    for (let cohort = 0; cohort < sample.cohorts; cohort += 1) {
      const cohortBlocks = blocks.filter((block) => block.cohort === cohort);
      assert.equal(cohortBlocks.filter((block) => block.abPattern === "ABBA").length, 6);
      assert.equal(cohortBlocks.filter((block) => block.aaPattern === "A0A1A1A0").length, 6);
      assert.equal(cohortBlocks.filter((block) => block.quartetOrder === "ab-first").length, 6);
      for (const [comparison, labels] of [["ab", ["A", "B"]], ["aa", ["A0", "A1"]]]) {
        for (const label of labels) {
          const rotations = cohortBlocks.flatMap((block) => block.processOrder)
            .filter((entry) => entry.comparison === comparison && entry.label === label)
            .map((entry) => entry.rotation);
          assert.deepEqual([0, 1, 2, 3].map((rotation) =>
            rotations.filter((value) => value === rotation).length), [6, 6, 6, 6]);
        }
      }
    }
  }
  return blocks;
}

function sanitizedSchedule(schedule) {
  return schedule.map((block) => ({ ...block, processOrder: block.processOrder.map((entry, slot) => ({
    slot,
    comparison: entry.comparison,
    label: entry.label,
    revision: entry.revision,
    rotation: entry.rotation,
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
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 32_768) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 32_768) stderr.push(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CHILD_TIMEOUT_MS);
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
  const decode = (chunks) => Buffer.concat(chunks).toString("utf8");
  return {
    ...result,
    durationNs: Number(process.hrtime.bigint() - started),
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function fixtureHashes(fixtureDir, manifest) {
  return Object.fromEntries(Object.entries(manifest.files).map(([name]) => [name, fileSha256(path.join(fixtureDir, name))]));
}

function aggregateBlocks(plan, receipts) {
  const byWorkload = new Map(plan.workloads.map(({ id }) => [id, []]));
  const grouped = new Map();
  for (const receipt of receipts) {
    for (const workload of receipt.workloads) {
      const key = `${receipt.block}:${workload.id}:${receipt.comparison}:${receipt.label}`;
      const values = grouped.get(key) ?? [];
      values.push(workload.samplesNs);
      grouped.set(key, values);
    }
  }
  for (let block = 0; block < Math.max(...receipts.map((receipt) => receipt.block)) + 1; block += 1) {
    const cohort = receipts.find((receipt) => receipt.block === block)?.cohort;
    for (const workload of plan.workloads) {
      const get = (comparison, label) => grouped.get(`${block}:${workload.id}:${comparison}:${label}`) ?? [];
      const a = get("ab", "A");
      const b = get("ab", "B");
      const a0 = get("aa", "A0");
      const a1 = get("aa", "A1");
      assert.equal(a.length, b.length);
      assert.equal(a0.length, a1.length);
      assert(a.length > 0 && a0.length > 0);
      assert(a.every((samples) => samples.length === a[0].length));
      assert(b.every((samples) => samples.length === b[0].length));
      assert(a0.every((samples) => samples.length === a0[0].length));
      assert(a1.every((samples) => samples.length === a1[0].length));
      // Each process arm gets equal weight regardless of within-process jitter.
      const baselineNs = mean(a.map(mean));
      const candidateNs = mean(b.map(mean));
      const a0Ns = mean(a0.map(mean));
      const a1Ns = mean(a1.map(mean));
      byWorkload.get(workload.id).push({
        block,
        cohort,
        ab: {
          baselineNs,
          candidateNs,
          logRatio: Math.log(candidateNs / baselineNs),
          differenceNs: candidateNs - baselineNs,
        },
        aa: {
          a0Ns,
          a1Ns,
          logRatio: Math.log(a1Ns / a0Ns),
          differenceNs: a1Ns - a0Ns,
        },
      });
    }
  }
  return byWorkload;
}

function metricPoint(records, comparison) {
  return {
    relativePercent: (Math.exp(median(records.map((record) => record[comparison].logRatio))) - 1) * 100,
    absoluteMicroseconds: median(records.map((record) => record[comparison].differenceNs)) / 1000,
  };
}

function bootstrapWorkload(records, plan, sample) {
  const random = xorshift32(plan.analysis.bootstrapSeed);
  const percent = { ab: [], aa: [] };
  const absolute = { ab: [], aa: [] };
  const cohorts = Array.from({ length: sample.cohorts }, (_unused, cohort) =>
    records.filter((record) => record.cohort === cohort));
  assert(cohorts.every((cohort) => cohort.length === sample.blocksPerCohort));
  for (let iteration = 0; iteration < sample.bootstrapIterations; iteration += 1) {
    const selected = [];
    for (const cohort of cohorts) {
      const runs = Math.ceil(cohort.length / plan.analysis.movingBlockLength);
      for (let run = 0; run < runs; run += 1) {
        const start = Math.floor(random() * cohort.length);
        for (let offset = 0; offset < plan.analysis.movingBlockLength; offset += 1) {
          if (selected.length % cohort.length === 0 && run >= runs) break;
          selected.push(cohort[(start + offset) % cohort.length]);
        }
      }
    }
    const expected = sample.blocks;
    const sampleRecords = selected.slice(0, expected);
    assert.equal(sampleRecords.length, expected);
    for (const comparison of ["ab", "aa"]) {
      const point = metricPoint(sampleRecords, comparison);
      percent[comparison].push(point.relativePercent);
      absolute[comparison].push(point.absoluteMicroseconds);
    }
  }
  const interval = (values) => {
    values.sort((left, right) => left - right);
    return { lower: quantile(values, 0.025), upper: quantile(values, 0.975) };
  };
  return {
    ab: { relativePercent: interval(percent.ab), absoluteMicroseconds: interval(absolute.ab) },
    aa: { relativePercent: interval(percent.aa), absoluteMicroseconds: interval(absolute.aa) },
  };
}

function classifyWorkload(records, intervals, plan) {
  const relative = plan.analysis.relativeRegressionPercent;
  const absolute = plan.analysis.absoluteRegressionMicroseconds;
  const abPoint = metricPoint(records, "ab");
  const aaPoint = metricPoint(records, "aa");
  const abExcludesMaterialRegression = intervals.ab.relativePercent.upper <= relative ||
    intervals.ab.absoluteMicroseconds.upper <= absolute;
  const abProvesRegression = intervals.ab.relativePercent.lower > relative &&
    intervals.ab.absoluteMicroseconds.lower > absolute;
  const aaRelativeContainsZero = intervals.aa.relativePercent.lower <= 0 &&
    intervals.aa.relativePercent.upper >= 0;
  const aaAbsoluteContainsZero = intervals.aa.absoluteMicroseconds.lower <= 0 &&
    intervals.aa.absoluteMicroseconds.upper >= 0;
  const aaRelativeEquivalent = intervals.aa.relativePercent.lower >= -relative &&
    intervals.aa.relativePercent.upper <= relative;
  const aaAbsoluteEquivalent = intervals.aa.absoluteMicroseconds.lower >= -absolute &&
    intervals.aa.absoluteMicroseconds.upper <= absolute;
  const aaContainsZero = aaRelativeContainsZero && aaAbsoluteContainsZero;
  const aaCalibrated = aaContainsZero && (aaRelativeEquivalent || aaAbsoluteEquivalent);
  const cohortDiagnostics = Array.from({ length: plan.sampling.cohorts }, (_unused, cohort) => ({
    cohort,
    ab: metricPoint(records.filter((record) => record.cohort === cohort), "ab"),
    aa: metricPoint(records.filter((record) => record.cohort === cohort), "aa"),
  }));
  const middle = records.filter((record) => {
    const local = record.block % plan.sampling.blocksPerCohort;
    return local >= 3 && local <= 8;
  });
  const outer = records.filter((record) => !middle.includes(record));
  const classification = !aaCalibrated ? "INCONCLUSIVE_AA_CALIBRATION"
    : abProvesRegression ? "REGRESSION"
      : abExcludesMaterialRegression ? "ACCEPT"
        : "INCONCLUSIVE";
  return {
    classification,
    ab: {
      point: abPoint,
      confidenceInterval: intervals.ab,
      excludesMaterialRegression: abExcludesMaterialRegression,
      provesMaterialRegression: abProvesRegression,
    },
    aa: {
      point: aaPoint,
      confidenceInterval: intervals.aa,
      relativeContainsZero: aaRelativeContainsZero,
      absoluteContainsZero: aaAbsoluteContainsZero,
      containsZero: aaContainsZero,
      relativeEquivalent: aaRelativeEquivalent,
      absoluteEquivalent: aaAbsoluteEquivalent,
      calibrated: aaCalibrated,
    },
    diagnostics: {
      nonGating: true,
      cohortPoints: cohortDiagnostics,
      middleBlocks: { ab: metricPoint(middle, "ab"), aa: metricPoint(middle, "aa") },
      outerBlocks: { ab: metricPoint(outer, "ab"), aa: metricPoint(outer, "aa") },
    },
  };
}

function renderMarkdownReport(report) {
  const lines = [
    "# PR #323 paired Windows archive proof",
    "",
    `Classification: **${report.classification}**`,
    "",
    `Mode: ${report.mode}${report.notPerformanceEvidence ? " (structural smoke; not performance evidence)" : ""}`,
    `Fresh single-variant processes: ${report.freshProcesses}`,
    `Baseline: \`${report.revisions.baseline}\``,
    `Candidate: \`${report.revisions.candidate}\``,
    "",
  ];
  if (report.mode === "production") {
    lines.push(
      "| Workload | Result | A/B point | A/B 95% relative CI | A/B 95% absolute CI | A/A calibrated |",
      "|---|---:|---:|---:|---:|---:|",
    );
    for (const result of report.results) {
      const percent = result.ab.confidenceInterval.relativePercent;
      const absolute = result.ab.confidenceInterval.absoluteMicroseconds;
      lines.push(`| ${result.workload} | ${result.classification} | ${result.ab.point.relativePercent.toFixed(3)}% / ${result.ab.point.absoluteMicroseconds.toFixed(3)} µs | [${percent.lower.toFixed(3)}, ${percent.upper.toFixed(3)}]% | [${absolute.lower.toFixed(3)}, ${absolute.upper.toFixed(3)}] µs | ${result.aa.calibrated} |`);
    }
  } else {
    lines.push("| Workload | A/B point | A/A point |", "|---|---:|---:|");
    for (const result of report.results) {
      lines.push(`| ${result.workload} | ${result.ab.point.relativePercent.toFixed(3)}% | ${result.aa.point.relativePercent.toFixed(3)}% |`);
    }
  }
  lines.push("", ...report.interpretation.map((line) => `- ${line}`), "");
  return `${lines.join("\n")}\n`;
}

async function childMain(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const receipt = {
    schema: 1,
    passed: false,
    launchOrdinal: config.launchOrdinal,
    block: config.block,
    cohort: config.cohort,
    slot: config.slot,
    comparison: config.comparison,
    label: config.label,
    revision: config.revision,
    workloadRotation: config.rotation,
    nativeMode: process.env.FS_SAFE_NATIVE_MODE,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      executableSha256: fileSha256(process.execPath),
    },
    startedAt: new Date().toISOString(),
    startResourceUsage: process.resourceUsage(),
    nativeLoads: [],
    nativeLoaderCalls: 0,
    workloads: [],
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
    const manifest = JSON.parse(fsSync.readFileSync(path.join(config.fixtureDir, "manifest.json"), "utf8"));
    receipt.fixtureHashesBefore = fixtureHashes(config.fixtureDir, manifest);
    originalNodeExtension = Module._extensions?.[".node"];
    if (originalNodeExtension) {
      Module._extensions[".node"] = (commonJsModule, filename) => {
        receipt.nativeLoads.push(path.basename(filename));
        throw new Error(`native addon load forbidden: ${path.basename(filename)}`);
      };
    }
    const archive = await import(pathToFileURL(path.join(config.repoDir, "dist/archive.js")).href);
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

    const expectedPayloads = new Map(Object.entries(manifest.payloads).map(([bytes, definition]) =>
      [bytes, Buffer.alloc(definition.bytes, definition.fillByte)]));
    const workloads = config.workloads.map((workload) => {
      const archivePath = path.join(config.fixtureDir, workload.fixture);
      const expectedPayload = manifest.payloads[String(workload.payloadBytes)];
      const validate = (result) => {
        if (workload.operation === "inspect") {
          assert.deepEqual(result, manifest.expectedManifests[workload.id]);
          return;
        }
        assert(Buffer.isBuffer(result));
        assert.equal(result.length, expectedPayload.bytes);
        const expected = expectedPayloads.get(String(workload.payloadBytes));
        assert(result.equals(expected), `${workload.id} returned different bytes`);
        assert.equal(sha256(result), expectedPayload.sha256);
      };
      const run = workload.operation === "inspect"
        ? () => archive.inspectTarArchive({ archivePath, timeoutMs: 30_000 })
        : () => archive.readArchiveEntry(archivePath, workload.entryPath, {
          maxBytes: workload.payloadBytes,
        });
      return { ...workload, run, validate };
    });
    const samples = new Map(workloads.map((workload) => [workload.id, {
      samplesNs: [],
      positions: [],
      rounds: [],
    }]));
    const roundOrder = (round) => workloads.map((_unused, index) =>
      workloads[(index + config.rotation + round) % workloads.length]);
    receipt.warmupRoundOrders = [];
    receipt.timedRoundOrders = [];
    // Preserve the benchmark runner's round shape: every round visits all four
    // workloads before the next round, rotating positions within each child.
    for (let round = 0; round < config.warmupCalls; round += 1) {
      const order = roundOrder(round);
      receipt.warmupRoundOrders.push(order.map((workload) => workload.id));
      for (const workload of order) workload.validate(await workload.run());
    }
    for (let round = 0; round < config.timedCalls; round += 1) {
      const order = roundOrder(round);
      receipt.timedRoundOrders.push(order.map((workload) => workload.id));
      for (const [position, workload] of order.entries()) {
        const started = process.hrtime.bigint();
        const result = await workload.run();
        const finished = process.hrtime.bigint();
        const workloadSamples = samples.get(workload.id);
        workloadSamples.samplesNs.push(Number(finished - started));
        workloadSamples.positions.push(position);
        workloadSamples.rounds.push(round);
        workload.validate(result);
      }
    }
    for (const [planOrder, workload] of workloads.entries()) {
      const workloadSamples = samples.get(workload.id);
      receipt.workloads.push({
        id: workload.id,
        planOrder,
        warmupCalls: config.warmupCalls,
        timedCalls: config.timedCalls,
        samplesNs: workloadSamples.samplesNs,
        timedPositions: workloadSamples.positions,
        timedRounds: workloadSamples.rounds,
      });
    }
    receipt.fixtureHashesAfter = fixtureHashes(config.fixtureDir, manifest);
    assert.deepEqual(receipt.fixtureHashesAfter, receipt.fixtureHashesBefore);
    assert.equal(receipt.nativeLoaderCalls, 0);
    assert.deepEqual(receipt.nativeLoads, []);
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
  const progress = {
    schema: 1,
    mode,
    notPerformanceEvidence: mode === "smoke",
    passed: false,
    classification: "INCOMPLETE",
    startedAt: new Date().toISOString(),
  };
  writeExclusive(path.join(output, "progress.json"), progress);
  try {
    const planPath = path.resolve(values.plan);
    const harnessPath = fsSync.realpathSync(process.argv[1]);
    const { plan, digest: planSha256, rawDigest: planRawSha256 } = validatePlan(planPath, mode);
    const repositories = validateRepositories(plan, values["baseline-dir"], values["candidate-dir"], mode);
    const sample = mode === "production" ? {
      blocks: plan.sampling.blocks,
      cohorts: plan.sampling.cohorts,
      blocksPerCohort: plan.sampling.blocksPerCohort,
      warmupCallsPerWorkload: plan.sampling.warmupCallsPerWorkload,
      timedCallsPerWorkload: plan.sampling.timedCallsPerWorkload,
      bootstrapIterations: plan.analysis.bootstrapIterations,
    } : SMOKE;
    assert.equal(sample.blocks, sample.cohorts * sample.blocksPerCohort);
    const fixtureDir = path.join(path.dirname(path.dirname(output)), "fixtures");
    const childReceiptDir = path.join(output, "child-receipts");
    const privateFixtureManifest = path.join(fixtureDir, "manifest.json");
    const evidencePlan = path.join(output, "plan.json");
    const evidenceFixtureManifest = path.join(output, "fixture-manifest.json");
    fsSync.mkdirSync(childReceiptDir);
    fsSync.copyFileSync(planPath, evidencePlan, fsSync.constants.COPYFILE_EXCL);
    const manifest = await createFixtures(fixtureDir, plan.workloads, repositories.baseline);
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
    assert.equal(fingerprintsBefore.baseline.files["benchmarks/archives.mjs"],
      fingerprintsBefore.candidate.files["benchmarks/archives.mjs"], "archive fixture definitions differ");
    const wasmAbi = {
      baseline: validateWasmAbi(repositories.baseline),
      candidate: validateWasmAbi(repositories.candidate),
    };
    const sourceTrees = {
      baseline: git(repositories.baseline, ["rev-parse", "HEAD^{tree}"]),
      candidate: git(repositories.candidate, ["rev-parse", "HEAD^{tree}"]),
    };
    const productionShape = {
      blocks: plan.sampling.blocks,
      cohorts: plan.sampling.cohorts,
      blocksPerCohort: plan.sampling.blocksPerCohort,
    };
    const productionSchedule = buildSchedule(plan, productionShape);
    const productionScheduleSha256 = sha256(json(sanitizedSchedule(productionSchedule)));
    const schedule = mode === "production" ? productionSchedule : buildSchedule(plan, sample);
    writeExclusive(path.join(output, "schedule.json"), {
      schema: 1,
      mode,
      scheduleSeed: plan.sampling.scheduleSeed,
      latinRotation: plan.sampling.workloadRotation,
      blocks: sanitizedSchedule(schedule),
    });
    writeExclusive(evidenceFixtureManifest, manifest);
    const integrityBefore = {
      harnessRawSha256: fileSha256(harnessPath),
      planRawSha256: fileSha256(planPath),
      evidencePlanRawSha256: fileSha256(evidencePlan),
      privateFixtureManifestSha256: fileSha256(privateFixtureManifest),
      evidenceFixtureManifestSha256: fileSha256(evidenceFixtureManifest),
    };
    assert.equal(integrityBefore.planRawSha256, integrityBefore.evidencePlanRawSha256);
    assert.equal(integrityBefore.privateFixtureManifestSha256,
      integrityBefore.evidenceFixtureManifestSha256);
    const expectedChildRuntime = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      executableSha256: fileSha256(process.execPath),
      nativeMode: "off",
    };
    writeExclusive(path.join(output, "preflight.json"), {
      schema: 1,
      mode,
      notPerformanceEvidence: mode === "smoke",
      planSha256,
      planRawSha256,
      harnessSha256: integrityBefore.harnessRawSha256,
      revisions: plan.revisions,
      runtime: {
        node: process.version,
        versions: process.versions,
        platform: process.platform,
        arch: process.arch,
        executableSha256: expectedChildRuntime.executableSha256,
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? null,
        totalMemoryBytes: os.totalmem(),
        runnerImage: {
          os: process.env.ImageOS ?? null,
          version: process.env.ImageVersion ?? null,
        },
      },
      sample,
      fixedProductionSample: plan.sampling,
      fixedAnalysis: plan.analysis,
      fingerprintsBefore,
      buildInputsBefore,
      checkoutCleanlinessBefore: repositories.cleanliness,
      wasmAbi,
      sourceTrees,
      productionScheduleSha256,
      integrityBefore,
      fixtureHashesBefore: fixtureHashes(fixtureDir, manifest),
      interpretation: [
        "Smoke mode is structural self-test only and cannot change production plan values.",
        "Each child loads one revision only; all public API results are validated outside timing.",
        "FS_SAFE_NATIVE_MODE=off is configured and asserted; loader and .node tripwires must remain untouched.",
        "A/B and A0/A1 use the same sampled block indices in every bootstrap draw.",
        "The bootstrap is fixed at 20,000 draws in production and stratified by four chronological cohorts.",
      ],
    });

    const receipts = [];
    const launchReceipts = [];
    const telemetry = [snapshotSystem("before-proof", fixtureDir)];
    writeExclusive(path.join(output, "telemetry.json"), { schema: 1, snapshots: telemetry });
    writeExclusive(path.join(output, "launches.json"), { schema: 1, launches: launchReceipts });
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
          repoDir,
          fixtureDir,
          receiptPath,
          workloads: plan.workloads,
          warmupCalls: sample.warmupCallsPerWorkload,
          timedCalls: sample.timedCallsPerWorkload,
          launchOrdinal,
          block: block.block,
          cohort: block.cohort,
          slot,
          comparison: processPlan.comparison,
          label: processPlan.label,
          revision: processPlan.revision,
          rotation: processPlan.rotation,
          expectedRuntime: expectedChildRuntime,
        };
        const launched = await spawnChild(configuration);
        const launchReceipt = {
          launchOrdinal,
          block: block.block,
          cohort: block.cohort,
          slot,
          comparison: processPlan.comparison,
          label: processPlan.label,
          revision: processPlan.revision,
          rotation: processPlan.rotation,
          receipt: `child-receipts/${receiptName}`,
          code: launched.code,
          signal: launched.signal,
          timedOut: launched.timedOut,
          durationNs: launched.durationNs,
          stdoutBytes: launched.stdoutBytes,
          stderrBytes: launched.stderrBytes,
          error: launched.error,
        };
        if (launched.stdout) launchReceipt.stdout = launched.stdout;
        if (launched.stderr) launchReceipt.stderr = launched.stderr;
        launchReceipts.push(launchReceipt);
        writeAtomic(path.join(output, "launches.json"), { schema: 1, launches: launchReceipts });
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
        ...progress,
        completedBlocks: block.block + 1,
        completedFreshProcesses: launchOrdinal,
      });
    }
    telemetry.push(snapshotSystem("after-proof", fixtureDir));
    writeAtomic(path.join(output, "telemetry.json"), { schema: 1, snapshots: telemetry });
    writeAtomic(path.join(output, "launches.json"), { schema: 1, launches: launchReceipts });
    const expectedProcesses = sample.blocks * plan.sampling.processesPerBlock;
    assert.equal(receipts.length, expectedProcesses);
    if (mode === "production") assert.equal(receipts.length, plan.sampling.expectedFreshProcesses);
    assert(receipts.every((receipt) => receipt.workloads.length === 4));
    assert(receipts.every((receipt) => receipt.runtime.node === expectedChildRuntime.node &&
      receipt.runtime.platform === expectedChildRuntime.platform &&
      receipt.runtime.arch === expectedChildRuntime.arch &&
      receipt.runtime.executableSha256 === expectedChildRuntime.executableSha256 &&
      receipt.nativeMode === expectedChildRuntime.nativeMode));
    assert(receipts.every((receipt) => receipt.workloads.every((workload) =>
      workload.warmupCalls === sample.warmupCallsPerWorkload &&
      workload.timedCalls === sample.timedCallsPerWorkload &&
      workload.samplesNs.length === sample.timedCallsPerWorkload)));
    if (mode === "production") {
      const workloadIds = plan.workloads.map((workload) => workload.id);
      for (const receipt of receipts) {
        for (const orders of [receipt.warmupRoundOrders, receipt.timedRoundOrders]) {
          assert.equal(orders.length, 16);
          assert(orders.every((order) => order.length === 4 &&
            [...order].sort().join("\0") === [...workloadIds].sort().join("\0")));
          for (const workloadId of workloadIds) {
            const positions = orders.map((order) => order.indexOf(workloadId));
            assert.deepEqual([0, 1, 2, 3].map((position) =>
              positions.filter((value) => value === position).length), [4, 4, 4, 4]);
          }
        }
      }
    }

    const rawSamples = receipts.flatMap((receipt) => receipt.workloads.flatMap((workload) =>
      workload.samplesNs.map((durationNs, sampleIndex) => ({
        launchOrdinal: receipt.launchOrdinal,
        block: receipt.block,
        cohort: receipt.cohort,
        comparison: receipt.comparison,
        label: receipt.label,
        revision: receipt.revision,
        rotation: receipt.workloadRotation,
        workload: workload.id,
        workloadPosition: workload.timedPositions[sampleIndex],
        round: workload.timedRounds[sampleIndex],
        sampleIndex,
        durationNs,
      }))));
    writeExclusive(path.join(output, "raw-samples.json"), { schema: 1, samples: rawSamples });
    const blocks = aggregateBlocks(plan, receipts);
    writeExclusive(path.join(output, "block-estimates.json"), {
      schema: 1,
      workloads: Object.fromEntries(blocks),
    });

    const results = [];
    if (mode === "production") {
      for (const workload of plan.workloads) {
        const records = blocks.get(workload.id);
        const intervals = bootstrapWorkload(records, plan, sample);
        results.push({ workload: workload.id, ...classifyWorkload(records, intervals, plan) });
      }
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
      harnessRawSha256: fileSha256(harnessPath),
      planRawSha256: fileSha256(planPath),
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
      "fixtures changed during proof");
    const classification = mode === "smoke" ? "SMOKE_ONLY"
      : results.every((result) => result.classification === "ACCEPT") ? "ACCEPT"
        : results.some((result) => result.classification === "REGRESSION") ? "REGRESSION"
          : "INCONCLUSIVE";
    const report = {
      schema: 1,
      mode,
      notPerformanceEvidence: mode === "smoke",
      classification,
      passed: mode === "smoke" || classification === "ACCEPT",
      revisions: plan.revisions,
      planSha256,
      planRawSha256,
      scheduleSeed: plan.sampling.scheduleSeed,
      bootstrapSeed: plan.analysis.bootstrapSeed,
      freshProcesses: receipts.length,
      sample,
      thresholds: {
        relativeRegressionPercent: plan.analysis.relativeRegressionPercent,
        absoluteRegressionMicroseconds: plan.analysis.absoluteRegressionMicroseconds,
      },
      bootstrap: mode === "production" ? {
        iterations: plan.analysis.bootstrapIterations,
        movingBlockLength: plan.analysis.movingBlockLength,
        stratification: plan.analysis.stratification,
        pairedAbAndAaIndices: true,
        intervalsAreMarginalPerWorkload: true,
      } : null,
      interpretation: mode === "production" ? [
        "Intervals are marginal per workload and do not claim simultaneous family-wise coverage.",
        "Middle-versus-outer and cohort diagnostics are reported without filtering or changing the gate.",
        "Acceptance is evidence against the defined dual-threshold regression on this hosted Windows environment, not universal proof of zero slowdown.",
      ] : ["Structural smoke only; timing values are not performance evidence."],
      results,
      fixtureHashesAfter,
      fingerprintsAfter,
      buildInputsAfter,
      checkoutCleanlinessAfter,
      integrityAfter,
      finishedAt: new Date().toISOString(),
    };
    writeExclusive(path.join(output, "report.json"), report);
    fsSync.writeFileSync(path.join(output, "report.md"), renderMarkdownReport(report), {
      flag: "wx",
      mode: 0o600,
    });
    writeAtomic(path.join(output, "progress.json"), report);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const failure = {
      ...progress,
      error: errorInfo(error),
      finishedAt: new Date().toISOString(),
    };
    writeAtomic(path.join(output, "progress.json"), failure);
    if (!fsSync.existsSync(path.join(output, "report.json"))) {
      writeExclusive(path.join(output, "report.json"), failure);
    }
    throw error;
  }
}

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    plan: { type: "string" },
    "baseline-dir": { type: "string" },
    "candidate-dir": { type: "string" },
    output: { type: "string" },
    "child-config": { type: "string" },
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
