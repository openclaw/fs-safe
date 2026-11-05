import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Hosted-only supervisor. The primary case and Python program remain unchanged;
// do not preload hooks, warm Python, or retry the case before recording its verdict.
assert.equal(process.env.GITHUB_ACTIONS, "true", "use only the reviewed hosted workflow");
const subject = "37595a2695c29d71c14a6b19559077ad266dcf7c";
const tree = "babc2304b430286c872e1314d7861ea0b1c2d62d";
const caseName = "round-trips binary bytes and literal POSIX names across filesystem operations";
const output = path.join(process.env.RUNNER_TEMP, "fs-safe-guest-timeout-diagnostic");
fs.mkdirSync(output);
const reportFile = path.join(output, "receipt.json");
const resultFile = path.join(output, "vitest.json");
const args = ["test:coverage:collect", "test/guest-filesystem.test.ts", "-t", caseName,
  "--reporter=default", "--reporter=json", `--outputFile=${resultFile}`];
const started = process.hrtime.bigint();
const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
const sha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 10_000 }).trim();
const receipt = {
  schema: 1, kind: "uninstrumented-named-coverage-diagnostic", verdict: "not-run",
  harnessCommit: process.env.GUEST_DIAG_HARNESS_COMMIT,
  harnessSha256: sha256(fileURLToPath(import.meta.url)),
  expectedSubject: subject, expectedTree: tree,
  command: ["pnpm", ...args], childDeadlineMs: 10_000, originalCaseDeadlineMs: 75_000,
  runner: { label: "xcode-27", image: process.env.ImageOS, imageVersion: process.env.ImageVersion,
    osRelease: os.release(), node: process.version, platform: process.platform, arch: process.arch },
  env: Object.fromEntries(["CI", "GITHUB_ACTIONS", "MACOSX_DEPLOYMENT_TARGET", "CARGO_INCREMENTAL",
    "CACHE_ON_FAILURE", "FS_SAFE_TEST_SERIAL", "FS_SAFE_NATIVE_MODE", "NODE_OPTIONS",
    "NODE_V8_COVERAGE", "PYTHONHOME", "PYTHONPATH"].map(key => [key, process.env[key] ?? null])),
  sourceSha256: {}, phases: [],
  guestIO: { inputBytes: 131089, synthetic: true, childStdoutBytes: null, childStderrBytes: null,
    lastChildPhase: null, limitation: "Unchanged primary test emits no child phase or raw spawn-result receipt." },
};
const checkpoint = phase => {
  receipt.phases.push({ phase, elapsedMs: elapsedMs(), utc: new Date().toISOString() });
  fs.writeFileSync(reportFile, `${JSON.stringify(receipt, null, 2)}\n`);
};
let exitCode = 1;
try {
  checkpoint("subject-verification");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.4");
  assert.deepEqual(git("rev-parse", "HEAD", "HEAD^{tree}").split(/\r?\n/u), [subject, tree]);
  assert.equal(git("status", "--porcelain"), "");
  receipt.source = { commit: subject, tree, dirty: false };
  for (const file of ["test/guest-filesystem.test.ts", "test/helpers/guest-filesystem.ts", "src/guest.ts",
    "src/guest-dispatch-python.ts", "src/guest-native-python.ts", "vitest.config.ts", "package.json", "pnpm-lock.yaml"]) {
    receipt.sourceSha256[file] = sha256(file);
  }
  assert.equal(process.env.GUEST_DIAG_NATIVE_BUILT, "1");
  const native = "packages/darwin-arm64/fs-safe-native.node";
  assert.ok(fs.statSync(native).size > 0);
  receipt.nativeBuilt = true; // Successful canonical build step plus staged binary presence.
  checkpoint("primary-command-start");
  const stdout = fs.openSync(path.join(output, "primary.stdout.log"), "wx");
  const stderr = fs.openSync(path.join(output, "primary.stderr.log"), "wx");
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn("pnpm", args, { stdio: ["ignore", stdout, stderr] });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  receipt.commandResult = { ...result, stdoutBytes: fs.statSync(path.join(output, "primary.stdout.log")).size,
    stderrBytes: fs.statSync(path.join(output, "primary.stderr.log")).size };
  checkpoint("primary-command-exit");
  const report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const assertions = report.testResults.flatMap(file => file.assertionResults);
  const selected = assertions.filter(test => test.status !== "pending" && test.status !== "skipped");
  assert.equal(selected.length, 1, "exactly one case must execute");
  assert.equal(selected[0].title, caseName);
  const test = selected[0];
  receipt.test = { fullName: test.fullName, status: test.status, durationMs: test.duration,
    failureMessages: test.failureMessages };
  receipt.verdict = test.status === "passed" && result.code === 0 ? "named-case-passed" : "named-case-failed";
  receipt.guestIO.childTimeoutObserved = test.failureMessages.some(message =>
    message.includes("spawnSync python3 ETIMEDOUT"));
  exitCode = receipt.verdict === "named-case-passed" ? 0 : 1;
  checkpoint("primary-verdict-recorded");
  // Probe metadata only after the primary verdict, so interpreter startup is not
  // warmed by this supervisor before the original test's first Python process.
  const python = spawnSync("python3", ["-c", "import json,sys; print(json.dumps({'executable':sys.executable,'version':sys.version}))"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" });
  receipt.python = { code: python.status, signal: python.signal, error: python.error?.message,
    stdout: python.stdout, stderr: python.stderr, timing: "after-primary-verdict" };
  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  receipt.pnpm = { code: pnpm.status, version: pnpm.stdout?.trim(), error: pnpm.error?.message };
  receipt.runner.macosVersion = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 10_000 }).trim();
  receipt.nativeSha256 = sha256(native);
  checkpoint("post-verdict-metadata-recorded");
} catch (error) {
  receipt.diagnosticError = { name: error.name, message: error.message };
  // Setup/collection errors never become a test pass or an assumed Python timeout.
  exitCode = 1;
} finally {
  checkpoint("supervisor-finish");
  console.log(JSON.stringify({ verdict: receipt.verdict, exitCode, receipt: reportFile }));
}
process.exitCode = exitCode;
