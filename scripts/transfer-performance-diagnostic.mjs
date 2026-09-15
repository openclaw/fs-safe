import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStableReportReceipt,
  assertStableSnapshots,
  createRunnerArguments,
  digestJson,
  measurementSequence,
  validateCompleteReportSet,
  validatePlanHash,
  validateRawReport,
} from "../benchmarks/method-audit-plan.mjs";
import { measuredSourceBinding } from "../benchmarks/measured-distribution.mjs";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  childMs: 180_000, snapshotMs: 120_000, terminationMs: 10_000, totalMs: 900_000,
  logBytes: 4 * 1024 * 1024, fileBytes: 16 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024, files: 48,
});
export const DIAGNOSTIC_FLAGS = Object.freeze([
  "--cpu-prof", "--cpu-prof-interval=1000", "--trace-opt", "--trace-deopt",
  "--trace-gc", "--trace-event-categories=v8",
]);
export const TRANSFER_ROWS = Object.freeze([
  "128", "65536", "1048576", "2097152", "signal", "observer", "authority",
  "observer+authority", "signal+observer+authority", "16777216", "33554432",
].map(name => `copyFileHandle/${name}`));
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const OPTIONS = ["plan", "expected-plan-file-hash", "harness-root", "candidate-root",
  "baseline-root", "scored-root", "output-root"];

class DiagnosticFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireValue(condition, code) { if (!condition) throw new DiagnosticFailure(code); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function selectDiagnosticReports(plan) {
  validatePlanHash(plan);
  const s = plan.settings;
  requireValue(s.platform === "windows" && s.nativeMode === "off" && s.nodeVersion === "24" &&
    s.filter === "copyFileHandle" && s.iterations === 50 && s.samples === 9 && s.blocks === 1 &&
    ["abba", "baab"].includes(s.order), "unsupported-diagnostic-profile");
  requireValue(s.expectedHarnessSha === plan.harness.sha, "unpinned-diagnostic-harness");
  for (const role of ["candidate", "baseline"]) {
    const source = plan.sources[role];
    requireValue(source && typeof source.commit === "string" && SHA1.test(source.commit) && source.requestedRef === source.commit,
      "unpinned-diagnostic-source");
  }
  const expected = measurementSequence({ order: s.order, blocks: 1, hasBaseline: true });
  requireValue(Array.isArray(plan.reports) && plan.reports.length === 4, "invalid-diagnostic-reports");
  for (let index = 0; index < expected.length; index += 1) {
    const entry = expected[index];
    const actual = plan.reports[index];
    requireValue(actual && ["block", "position", "sequence", "role", "label"].every(key => actual[key] === entry[key]) &&
      actual.mode === "off" && actual.file === `${entry.label}-off.json`, "invalid-diagnostic-order");
  }
  return plan.reports;
}

export function diagnosticArguments(plan, reportPlan, roots, directory) {
  const build = plan.builds.find(entry => entry.id === reportPlan.buildId);
  requireValue(build && ["candidate", "baseline"].includes(build.checkout), "invalid-diagnostic-build");
  return [
    ...DIAGNOSTIC_FLAGS,
    `--cpu-prof-dir=${directory}`, "--cpu-prof-name=cpu.cpuprofile",
    `--trace-event-file-pattern=${path.join(directory, "trace.${rotation}.json")}`,
    ...createRunnerArguments({
      runnerFile: path.join(roots.harness, "benchmarks", "runner.mjs"),
      distRoot: path.join(roots[build.checkout], "dist"),
      reportFile: path.join(directory, "report.json"),
      mode: reportPlan.mode, settings: plan.settings,
      measuredSource: measuredSourceBinding(plan, reportPlan),
    }),
  ];
}

export function validateDiagnosticRows(report) {
  requireValue(JSON.stringify(report.results?.map(row => row.name)) === JSON.stringify(TRANSFER_ROWS),
    "diagnostic-row-order-changed");
  for (let index = 0; index < TRANSFER_ROWS.length; index += 1) {
    const row = report.results[index];
    requireValue(row.skipped === undefined && row.iterations === (index < 3 ? 50 : 5) &&
      Array.isArray(row.samplesUs) && row.samplesUs.length === 9 &&
      Array.from(row.samplesUs).every(value => Number.isFinite(value) && value >= 0), "invalid-diagnostic-samples");
  }
  const observer = report.results[5].samplesUs;
  return observer.indexOf(Math.max(...observer)) + 1;
}

function readChecked(file, limit = DIAGNOSTIC_LIMITS.fileBytes) {
  const before = fs.lstatSync(file, { bigint: true });
  requireValue(before.isFile() && before.size <= BigInt(limit), "unsafe-or-oversized-file");
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    requireValue(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino &&
      opened.size === before.size && opened.mtimeNs === before.mtimeNs, "file-identity-changed");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireValue(count > 0, "file-short-read");
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    requireValue(bytes.length === Number(before.size) && named.isFile() &&
      [after, named].every(stat => stat.dev === before.dev && stat.ino === before.ino &&
        stat.size === before.size && stat.mtimeNs === before.mtimeNs), "file-changed-during-read");
    return { bytes, evidence: { sha256: sha256(bytes), size: bytes.length,
      dev: String(before.dev), ino: String(before.ino), mtimeNs: String(before.mtimeNs) } };
  } finally { fs.closeSync(fd); }
}
function readJson(file) { return JSON.parse(readChecked(file).bytes.toString("utf8")); }

function parseOptions(argv) {
  requireValue(argv.length === OPTIONS.length * 2, "invalid-arguments");
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].slice(2);
    requireValue(argv[index] === `--${key}` && OPTIONS.includes(key) && options[key] === undefined,
      "invalid-argument-name");
    options[key] = argv[index + 1];
  }
  requireValue(SHA256.test(options["expected-plan-file-hash"]), "invalid-plan-file-hash");
  for (const key of OPTIONS.filter(key => key !== "expected-plan-file-hash")) {
    requireValue(path.isAbsolute(options[key]), "nonabsolute-argument");
    options[key] = path.resolve(options[key]);
  }
  return options;
}

function inventory(root) {
  const files = [];
  let bytes = 0;
  for (const directory of fs.readdirSync(root)) {
    requireValue(/^(capabilities|snapshot-before|snapshot-after|block-1-(baseline|candidate)-[ab]-off)$/u.test(directory),
      "unexpected-diagnostic-directory");
    const directoryPath = path.join(root, directory);
    const stat = fs.lstatSync(directoryPath);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe-diagnostic-directory");
    for (const name of fs.readdirSync(directoryPath)) {
      requireValue(/^(stdout\.log|stderr\.log|snapshot\.json|report\.json|cpu\.cpuprofile|trace\.[1-9][0-9]*\.json)$/u.test(name),
        "unexpected-diagnostic-file");
      const file = path.join(directoryPath, name);
      const info = fs.lstatSync(file);
      requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= DIAGNOSTIC_LIMITS.fileBytes,
        "unsafe-or-oversized-file");
      bytes += info.size;
      files.push({ relative: `${directory}/${name}`, file });
      requireValue(bytes <= DIAGNOSTIC_LIMITS.totalBytes && files.length <= DIAGNOSTIC_LIMITS.files,
        "diagnostic-output-limit");
    }
  }
  return files;
}

async function runChild(args, directory, context, timeoutMs) {
  requireValue(Date.now() < context.deadline, "diagnostic-deadline");
  fs.mkdirSync(directory);
  const logFds = [];
  const sizes = [0, 0];
  const started = Date.now();
  let failure;
  let child;
  try {
    for (const name of ["stdout.log", "stderr.log"]) logFds.push(fs.openSync(path.join(directory, name), "wx", 0o600));
    await new Promise((resolve, reject) => {
      let settled = false;
      let terminationTimer;
      let timer;
      const finish = (code, terminationConfirmed) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(terminationTimer);
        context.launches.push({ id: path.basename(directory), exitCode: code, terminationConfirmed,
          elapsedMs: Date.now() - started, argv: args,
          failure: failure ?? null });
        if (failure || code !== 0) reject(new DiagnosticFailure(failure || "diagnostic-child-exit"));
        else resolve(undefined);
      };
      const stop = code => {
        if (failure) return;
        failure = code;
        if (Number.isSafeInteger(child?.pid)) {
          // The diagnostic runs only on Windows; include inherited subprocesses.
          try {
            spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
              ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
          } catch { /* Still attempt direct termination and retain the bounded drain. */ }
          try { child.kill("SIGKILL"); } catch { /* A missed close is recorded as unconfirmed termination. */ }
        }
        terminationTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(null, false);
        }, DIAGNOSTIC_LIMITS.terminationMs);
      };
      child = spawn(process.execPath, args, {
        cwd: context.roots.harness, windowsHide: true,
        env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" }, stdio: ["ignore", "pipe", "pipe"],
      });
      timer = setInterval(() => {
        if (Date.now() >= Math.min(context.deadline, started + timeoutMs)) stop("diagnostic-child-timeout");
        try { inventory(context.work); } catch { stop("diagnostic-output-limit"); }
      }, 100);
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on("error", () => stop("diagnostic-log-read"));
        stream.on("data", chunk => {
          if (failure) return;
          if (sizes[index] + chunk.length > DIAGNOSTIC_LIMITS.logBytes) { stop("diagnostic-log-limit"); return; }
          try {
            let offset = 0;
            while (offset < chunk.length) {
              const written = fs.writeSync(logFds[index], chunk, offset, chunk.length - offset);
              requireValue(written > 0, "diagnostic-log-write");
              offset += written;
            }
            sizes[index] += chunk.length;
          }
          catch { stop("diagnostic-log-write"); }
        });
      }
      child.once("error", () => { stop("diagnostic-child-start"); });
      child.once("close", code => finish(code, true));
    });
  } finally { for (const fd of logFds) fs.closeSync(fd); }
  for (const { relative, file } of inventory(context.work)) {
    if (relative.startsWith(`${path.basename(directory)}/`)) context.produced.set(relative, readChecked(file).evidence);
  }
}

async function snapshot(label, options, context) {
  const directory = path.join(context.work, label);
  const file = path.join(directory, "snapshot.json");
  await runChild([path.join(context.roots.harness, "benchmarks", "method-audit-evidence.mjs"), "snapshot",
    "--plan", options.plan, "--expected-plan-file-hash", options["expected-plan-file-hash"],
    "--harness-root", context.roots.harness, "--candidate-root", context.roots.candidate,
    "--baseline-root", context.roots.baseline, "--output", file], directory, context, DIAGNOSTIC_LIMITS.snapshotMs);
  return readJson(file);
}

async function collect(options, context, receipt) {
  requireValue(process.platform === "win32" && process.arch === "x64" && process.version.startsWith("v24."),
    "unsupported-diagnostic-runtime");
  requireValue(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "diagnostic-requires-hosted-runner");
  requireValue(["NODE_OPTIONS", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE"].every(key => !process.env[key]),
    "injected-runtime-profile");
  const input = readChecked(options.plan);
  requireValue(input.evidence.sha256 === options["expected-plan-file-hash"], "plan-file-hash-mismatch");
  const plan = JSON.parse(input.bytes.toString("utf8"));
  const reports = selectDiagnosticReports(plan);
  requireValue(plan.repository === process.env.GITHUB_REPOSITORY && String(plan.run.id) === process.env.GITHUB_RUN_ID &&
    String(plan.run.attempt) === process.env.GITHUB_RUN_ATTEMPT, "diagnostic-run-mismatch");
  receipt.plan = plan;
  receipt.planFile = input.evidence;
  receipt.launcher = readChecked(fileURLToPath(import.meta.url)).evidence;
  receipt.runtime = { node: process.version, v8: process.versions.v8, uv: process.versions.uv,
    platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
    executable: readChecked(process.execPath, 256 * 1024 * 1024).evidence,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  const studyFile = path.join(options["scored-root"], "study-provenance.json");
  const studyInput = readChecked(studyFile);
  const study = JSON.parse(studyInput.bytes.toString("utf8"));
  requireValue(digestJson(study.plan) === digestJson(plan) && study.platform === "windows", "scored-study-mismatch");
  const scored = new Map();
  const scoredReceipts = new Map();
  for (const reportPlan of reports) {
    const file = readChecked(path.join(options["scored-root"], reportPlan.file));
    requireValue(file.evidence.sha256 === study.reports[reportPlan.file], "scored-report-hash-mismatch");
    scored.set(reportPlan.file, JSON.parse(file.bytes.toString("utf8")));
    scoredReceipts.set(reportPlan.file, file.evidence);
  }
  validateCompleteReportSet(plan, scored, study.before, study.after);
  requireValue([...scored.values()].every(report => report.metadata.node === process.version &&
    report.metadata.platform === process.platform && report.metadata.arch === process.arch &&
    report.metadata.cpu === receipt.runtime.cpu), "scored-runtime-drift");
  receipt.scoredStudy = studyInput.evidence;
  const capabilities = path.join(context.work, "capabilities");
  await runChild(["--v8-options"], capabilities, context, 30_000);
  const flags = readChecked(path.join(capabilities, "stdout.log")).bytes.toString("utf8");
  for (const flag of ["trace-opt", "trace-deopt", "trace-gc"]) {
    requireValue(new RegExp(`^\\s*--${flag}\\s+\\(`, "mu").test(flags), "missing-v8-diagnostic-flag");
  }
  const before = await snapshot("snapshot-before", options, context);
  assertStableSnapshots(study.after, before);
  receipt.reports = [];
  const produced = new Map();
  for (const reportPlan of reports) {
    const id = reportPlan.file.slice(0, -5);
    const directory = path.join(context.work, id);
    await runChild(diagnosticArguments(plan, reportPlan, context.roots, directory),
      directory, context, DIAGNOSTIC_LIMITS.childMs);
    const raw = readChecked(path.join(directory, "report.json"));
    const report = JSON.parse(raw.bytes.toString("utf8"));
    validateRawReport(plan, reportPlan, report, before);
    requireValue(report.metadata.node === process.version && report.metadata.platform === process.platform &&
      report.metadata.arch === process.arch && report.metadata.cpu === receipt.runtime.cpu, "diagnostic-runtime-drift");
    const profile = readJson(path.join(directory, "cpu.cpuprofile"));
    requireValue(Array.isArray(profile.nodes) && profile.nodes.length > 0 &&
      Array.isArray(profile.samples) && profile.samples.length > 0 &&
      Array.isArray(profile.timeDeltas) && profile.timeDeltas.length === profile.samples.length &&
      Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime) && profile.endTime >= profile.startTime,
      "invalid-cpu-profile");
    const traceNames = fs.readdirSync(directory).filter(name => /^trace\.[1-9][0-9]*\.json$/u.test(name));
    requireValue(traceNames.length > 0, "missing-v8-trace");
    for (const name of traceNames) {
      const events = readJson(path.join(directory, name)).traceEvents;
      requireValue(Array.isArray(events) && events.length > 0, "invalid-v8-trace");
    }
    produced.set(reportPlan.file, { file: path.join(directory, "report.json"), evidence: raw.evidence });
    receipt.reports.push({ ...reportPlan, scored: false, rawReport: raw.evidence,
      diagnosticObserverPeakSample: validateDiagnosticRows(report),
      scoredObserverPeakSample: validateDiagnosticRows(scored.get(reportPlan.file)) });
  }
  const after = await snapshot("snapshot-after", options, context);
  assertStableSnapshots(before, after);
  requireValue(readChecked(options.plan).evidence.sha256 === input.evidence.sha256, "plan-changed");
  requireValue(readChecked(studyFile).evidence.sha256 === studyInput.evidence.sha256, "scored-study-changed");
  for (const [file, evidence] of scoredReceipts) {
    assertStableReportReceipt(file, evidence, readChecked(path.join(options["scored-root"], file)).evidence);
  }
  for (const { file, evidence } of produced.values()) {
    assertStableReportReceipt(path.basename(file), evidence, readChecked(file).evidence);
  }
  assertStableReportReceipt("diagnostic launcher", receipt.launcher, readChecked(fileURLToPath(import.meta.url)).evidence);
  assertStableReportReceipt("Node executable", receipt.runtime.executable, readChecked(process.execPath, 256 * 1024 * 1024).evidence);
  requireValue(Date.now() < context.deadline, "diagnostic-deadline");
  receipt.identityStableThroughDiagnostics = true;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const output = options["output-root"];
  requireValue(process.env.RUNNER_TEMP && path.dirname(output) === path.resolve(process.env.RUNNER_TEMP) &&
    path.basename(output) === "transfer-performance-diagnostics", "invalid-diagnostic-output-root");
  fs.mkdirSync(output);
  const work = fs.mkdtempSync(path.join(path.resolve(process.env.RUNNER_TEMP), "transfer-diagnostic-work-"));
  const receipt = { schema: "fs-safe-transfer-diagnostics-v1", scored: false, status: "pending", complete: false,
    limits: DIAGNOSTIC_LIMITS, flags: DIAGNOSTIC_FLAGS, launches: [], files: {} };
  const receiptPath = path.join(output, "receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  const context = { work, produced: new Map(), launches: receipt.launches, deadline: Date.now() + DIAGNOSTIC_LIMITS.totalMs,
    roots: Object.fromEntries(["harness", "candidate", "baseline"].map(role => [role, options[`${role}-root`]])) };
  try {
    await collect(options, context, receipt);
    const files = inventory(work);
    requireValue(files.length === context.produced.size, "diagnostic-file-set-changed");
    for (const { relative, file } of files) {
      const checked = readChecked(file);
      assertStableReportReceipt(relative, context.produced.get(relative), checked.evidence);
      const destination = path.join(output, "files", relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, checked.bytes, { flag: "wx", mode: 0o600 });
      receipt.files[relative] = checked.evidence;
    }
    receipt.status = "collected";
    receipt.complete = true;
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = { code: error instanceof DiagnosticFailure ? error.code : "diagnostic-validation-failed" };
    process.exitCode = 2;
  }
  const finalFile = path.join(work, "receipt-final.json");
  fs.writeFileSync(finalFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(finalFile, receiptPath);
  process.stdout.write(`Unscored transfer diagnostics: ${receipt.status}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Unscored transfer diagnostic startup/emission failed\n"); process.exitCode = 2; });
}
