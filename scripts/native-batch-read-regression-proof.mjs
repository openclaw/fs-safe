import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { packageProofSource } from "./consumer-proof-metadata.mjs";

// Hosted qualification of the read-owner repair, using the same N-API8 addon
// and identical fixture against its immutable pre-fix base and candidate.
const baseline = path.resolve("artifacts/native-batch-read-baseline");
const output = path.resolve("artifacts/native-batch-read-proof.json");
const baselineCommit = "7d307d46028de5c7dcf37cf511b2fe94d5896821";
const fixture = "test/fixtures/native-worker-fd-ownership.mjs";
const receipt = { schema: 1, passed: false, results: [] };
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
const warning = /File descriptor .*closed but not opened in unmanaged mode/u;

async function observe(repo, scenario) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-read-owner-")));
  fs.writeFileSync(path.join(directory, "sentinel.txt"), "node-owned");
  const sentinelIdentity = fs.statSync(path.join(directory, "sentinel.txt"), { bigint: true });
  const worker = new Worker(path.resolve(repo, fixture), {
    workerData: { directory, batchReadScenario: scenario }, stdout: true, stderr: true,
  });
  const observed = { scenario, leaves: [], stderr: "" };
  worker.stdout.resume();
  worker.stderr.setEncoding("utf8").on("data", chunk => { observed.stderr += chunk; });
  let sentinelFd, timer;
  worker.on("message", message => {
    if (message.kind === "sentinel") sentinelFd = message.fd;
    else if (message.kind === "batch-read") observed.leaves.push(message);
    else if (message.kind === "result") observed.result = message;
  });
  worker.on("error", error => { observed.workerError = { code: error.code, message: error.message }; });
  try {
    observed.exitCode = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("native ownership Worker timed out")), 20_000);
      worker.once("exit", resolve);
    });
    assert.equal(observed.workerError, undefined, "Worker setup/uncaught failure is not a baseline verdict");
    assert.equal(typeof sentinelFd, "number");
    let sentinelStillOpen = false;
    try {
      const current = fs.fstatSync(sentinelFd, { bigint: true });
      sentinelStillOpen = current.dev === sentinelIdentity.dev && current.ino === sentinelIdentity.ino;
    } catch (error) { if (error.code !== "EBADF") throw error; }
    assert.equal(sentinelStillOpen, false, "Node must reclaim its own sentinel");
    observed.nodeSentinelReclaimed = true;
    return observed;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

try {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v26.13.0");
  assert.ok(Number(process.versions.napi) >= 8, "the shared addon requires N-API8");
  receipt.runtime = { node: process.version, napi: process.versions.napi, modules: process.versions.modules };
  receipt.candidate = packageProofSource();
  assert.equal(receipt.candidate.commit, process.env.FS_SAFE_EXPECTED_SOURCE_COMMIT);
  assert.equal(receipt.candidate.dirty, false);
  receipt.baseline = packageProofSource(baseline);
  assert.equal(receipt.baseline.commit, baselineCommit);
  assert.equal(receipt.baseline.dirty, false);
  // No old dependency/runtime transplant: these contracts must be identical.
  for (const file of ["package.json", "pnpm-lock.yaml", "tsconfig.json", "native", "archive-core"]) {
    assert.equal(git(".", "rev-parse", `HEAD:${file}`), git(baseline, "rev-parse", `HEAD:${file}`),
      `baseline ${file} differs; needs separate qualification`);
  }
  const build = JSON.parse(fs.readFileSync("release-artifacts/package-build-proof.json", "utf8"));
  assert.deepEqual(build.source, receipt.candidate);
  receipt.binarySha256 = JSON.parse(fs.readFileSync("release-artifacts/windows-native-pe.json", "utf8")).binarySha256;
  receipt.fixtureSha256 = hash(fixture);
  // Preserve already-qualified helper/WASM assets, compile the baseline's own
  // JavaScript with the existing pinned compiler, then copy only the regression.
  fs.cpSync("dist", path.join(baseline, "dist"), { recursive: true });
  const require = createRequire(import.meta.url);
  const compilerPackage = require.resolve("typescript/package.json");
  const compiler = path.resolve(path.dirname(compilerPackage), require(compilerPackage).bin.tsc);
  execFileSync(process.execPath, [compiler, "-p", path.join(baseline, "tsconfig.json")], {
    stdio: "inherit", timeout: 120_000,
  });
  fs.copyFileSync(fixture, path.join(baseline, fixture));
  assert.equal(hash(path.join(baseline, fixture)), receipt.fixtureSha256);
  receipt.compiledOwners = {};
  for (const file of ["root-file-open-batch-sync.js", "root-file.js", "pinned-open.js"]) {
    receipt.compiledOwners[file] = { baseline: hash(path.join(baseline, "dist", file)), candidate: hash(path.join("dist", file)) };
    assert.notEqual(receipt.compiledOwners[file].baseline, receipt.compiledOwners[file].candidate);
  }
  for (const scenario of ["transfer", "rejection"]) {
    for (const variant of ["baseline", "candidate"]) {
      const observed = await observe(variant === "baseline" ? baseline : ".", scenario);
      receipt.results.push({ variant, ...observed });
      assert.equal(observed.leaves.length, 1, "must reach actual native batch allocation");
      const leaf = observed.leaves[0];
      assert.equal(leaf.scenario, scenario);
      assert.equal(leaf.nativeLoaded, true);
      assert.equal(leaf.binarySha256, receipt.binarySha256);
      assert.equal(leaf.node, process.version);
      assert.equal(leaf.napi, process.versions.napi);
      assert.equal(leaf.modules, process.versions.modules);
      assert.equal(leaf.leafClosed, true);
      if (variant === "baseline") {
        assert.equal(observed.exitCode, 1);
        assert.equal(observed.result?.failure?.code, "ERR_ASSERTION");
        assert.ok(observed.result.failure.message.startsWith(`native batch-read ${scenario} bypassed originating closer`));
        assert.equal(leaf.originCloses, 0);
        assert.ok(observed.result.warnings.some(message => warning.test(message)), "baseline must expose the unmanaged-close warning");
      } else {
        assert.equal(observed.exitCode, 0);
        assert.equal(observed.result?.failure, undefined);
        assert.ok(observed.result.completed.includes(`batch-read-${scenario}`));
        assert.equal(leaf.originCloses, 1);
        assert.deepEqual(observed.result.warnings, []);
        assert.equal(warning.test(observed.stderr), false);
      }
    }
  }
  receipt.passed = true;
} catch (error) {
  receipt.error = { code: error.code, message: error.message };
  throw error;
} finally {
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
}
