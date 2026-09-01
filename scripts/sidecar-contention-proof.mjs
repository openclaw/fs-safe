// Built public API proof: pnpm build, then node scripts/sidecar-contention-proof.mjs off|auto|require
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "auto";
const worker = process.argv[3] === "--worker";
const processes = 4;
const acquisitionsPerProcess = 25;
const childDeadlineMs = 60_000;
const cases = [
  { name: "pathname-async", rooted: false, sync: false },
  { name: "pathname-sync", rooted: false, sync: true },
  { name: "root-async", rooted: true, sync: false },
  { name: "root-sync", rooted: true, sync: true },
];
const runtime = {
  platform: process.platform, arch: process.arch, node: process.version,
  nativeMode: ["off", "auto", "require"].includes(mode) ? mode : "invalid",
};
const emit = (value) => console.log(JSON.stringify({ proof: "sidecar-contention", ...runtime, ...value }));
const safeLabel = (value) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
  ? value : undefined;
// Never forward error messages, paths, stacks, sidecar bytes, or child output.
const errorShape = (error) => ({ name: safeLabel(error?.name), code: safeLabel(error?.code) });
const absent = (file) => assert.throws(() => fs.lstatSync(file), { code: "ENOENT" });
const lockOptions = () => ({
  staleMs: 60_000,
  timeoutMs: 15_000,
  retry: { retries: 15_000, factor: 1, minTimeout: 1, maxTimeout: 5, randomize: true },
  staleRecovery: "fail-closed",
  // Deliberately omit createdAt: contention must use the snapshot-mtime fallback.
  payload: () => ({ pid: process.pid }),
});
let root, acquireFileLock, acquireFileLockSync;
let phase = "setup";
let completed = 0;

function parentBarrier(notification, command) {
  return new Promise((resolve, reject) => {
    process.once("message", (message) => message === command ? resolve() : reject(new Error()));
    process.send(notification, (error) => { if (error) reject(error); });
  });
}

async function runWorker(test, directory) {
  directory = fs.realpathSync(directory);
  const target = path.join(directory, "state");
  const marker = path.join(directory, "critical");
  // Both APIs accept the documented Root capability; there is no RootSync API.
  const lockRoot = test.rooted ? await root(directory) : undefined;
  const options = { ...lockOptions(), lockRoot };
  phase = "start-barrier";
  await parentBarrier("ready", "start");
  const waitWord = new Int32Array(new SharedArrayBuffer(4));
  for (let index = 0; index < acquisitionsPerProcess; index += 1) {
    phase = "acquire";
    const handle = test.sync ? acquireFileLockSync(target, options) : await acquireFileLock(target, options);
    let descriptor;
    try {
      phase = "verify-fresh";
      assert.equal(await handle.verifyStillHeld(), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(handle.lockPath, "utf8")), { pid: process.pid });
      phase = "exclusive-marker";
      descriptor = fs.openSync(marker, "wx", 0o600);
      phase = "counter-read";
      const previous = JSON.parse(fs.readFileSync(target, "utf8"));
      assert.ok(Number.isSafeInteger(previous) && previous >= 0 && previous < processes * acquisitionsPerProcess);
      if (test.sync) Atomics.wait(waitWord, 0, 0, 2);
      else await pause(2);
      phase = "verify-critical-section";
      assert.equal(await handle.verifyStillHeld(), true);
      phase = "counter-write";
      fs.writeFileSync(target, `${previous + 1}\n`);
    } finally {
      // A failed exclusive open must never unlink another holder's marker.
      try {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); }
          finally { fs.unlinkSync(marker); }
        }
      } finally {
        const workPhase = phase;
        phase = "release";
        if (test.sync) handle.release();
        else await handle.release();
        phase = workPhase;
      }
    }
    completed += 1;
  }
  // Keep exit cleanup from hiding a release that returned without removing its sidecar.
  phase = "release-barrier";
  await parentBarrier("released", "finish");
}

function launchWorker(test, directory, index) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, "--worker", test.name, directory], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], shell: false,
  });
  let stdout = "", stderrSeen = false, outputOverflow = false, timedOut = false, closed = false, childError;
  let readyResolve, releasedResolve, releasedSeen = false;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const released = new Promise((resolve) => { releasedResolve = resolve; });
  const stop = () => {
    if (!closed) {
      try { child.kill("SIGKILL"); }
      catch (error) { childError = errorShape(error); }
    }
  };
  const deadline = setTimeout(() => { timedOut = true; stop(); }, childDeadlineMs);
  child.stdout.on("data", (chunk) => {
    if (stdout.length + chunk.length > 4_096) outputOverflow = true;
    else stdout += chunk.toString();
  });
  child.stderr.on("data", () => { stderrSeen = true; });
  child.on("message", (message) => {
    if (message === "ready") readyResolve(true);
    if (message === "released") { releasedSeen = true; releasedResolve(true); }
  });
  child.on("error", (error) => { childError = errorShape(error); stop(); });
  const done = new Promise((resolve) => {
    child.once("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(deadline);
      readyResolve(false);
      releasedResolve(false);
      let report;
      try { report = JSON.parse(stdout); } catch { /* Raw output stays private. */ }
      const count = Number.isSafeInteger(report?.completed) && report.completed >= 0
        && report.completed <= acquisitionsPerProcess ? report.completed : releasedSeen ? acquisitionsPerProcess : 0;
      const passed = exitCode === 0 && !signal && !timedOut && !childError && !outputOverflow
        && report?.outcome === "passed" && count === acquisitionsPerProcess;
      resolve({
        worker: index, outcome: passed ? "passed" : "failed", completed: count,
        ...(passed ? {} : {
          exitCode, signal: safeLabel(signal), timedOut, stderrSeen, outputOverflow,
          phase: safeLabel(report?.phase), error: childError ?? errorShape(report?.error),
        }),
      });
    });
  });
  return {
    ready, released, done, stop,
    send(command) {
      child.send(command, (error) => {
        if (error) { childError = errorShape(error); stop(); }
      });
    },
  };
}

async function runContentionCase(test, directory) {
  const children = [];
  let results = [];
  const result = {
    case: test.name, processes, acquisitionsPerProcess, expectedAcquisitions: processes * acquisitionsPerProcess,
    completedAcquisitions: 0, outcome: "failed",
  };
  let casePhase = "setup";
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(directory, "state");
    fs.writeFileSync(target, "0\n", { flag: "wx", mode: 0o600 });
    for (let index = 0; index < processes; index += 1) children.push(launchWorker(test, directory, index));
    casePhase = "start-barrier";
    const ready = await Promise.all(children.map((child) => child.ready));
    assert.ok(ready.every(Boolean));
    for (const child of children) child.send("start");
    casePhase = "release-barrier";
    const released = await Promise.all(children.map((child) => child.released));
    assert.ok(released.every(Boolean));
    casePhase = "counter-final";
    const counter = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(counter, processes * acquisitionsPerProcess);
    result.counter = counter;
    casePhase = "marker-absent";
    absent(path.join(directory, "critical"));
    casePhase = "sidecar-absent";
    absent(`${target}.lock`);
    absent(`${target}.lock.reclaim`);
    casePhase = "children";
    for (const child of children) child.send("finish");
    results = await Promise.all(children.map((child) => child.done));
    assert.ok(results.every((child) => child.outcome === "passed"));
    Object.assign(result, { outcome: "passed", markerAbsent: true, sidecarAbsent: true });
  } catch (error) {
    Object.assign(result, { phase: casePhase, error: errorShape(error) });
  } finally {
    // Also covers partial spawn/start failures: reap every sibling before scratch cleanup.
    for (const child of children) child.stop();
    const settled = await Promise.allSettled(children.map((child) => child.done));
    results = settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
    result.launchedProcesses = children.length;
    result.completedAcquisitions = results.reduce((total, child) => total + child.completed, 0);
    if (result.outcome === "failed") result.workers = results;
  }
  return result;
}

function runPermissionCase(directory) {
  const result = { case: "posix-release-retry", processes: 1, completedAcquisitions: 0, outcome: "failed" };
  const skip = process.platform === "win32" ? "windows" :
    process.getuid?.() === 0 || process.geteuid?.() === 0 ? "root-user" : undefined;
  if (skip) return { ...result, processes: 0, outcome: "skipped", reason: skip };
  let oldHandle;
  let casePhase = "setup";
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(directory, "state");
    casePhase = "acquire-original";
    oldHandle = acquireFileLockSync(target, lockOptions());
    assert.equal(oldHandle.verifyStillHeld(), true);
    try {
      casePhase = "permission-denial";
      fs.chmodSync(directory, 0o500);
      let releaseError;
      try { oldHandle.release(); } catch (error) { releaseError = error; }
      result.firstReleaseError = safeLabel(releaseError?.code) ?? "none";
      assert.equal(releaseError?.code, "EACCES");
    } finally {
      fs.chmodSync(directory, 0o700);
    }
    casePhase = "retained-ownership";
    assert.equal(fs.lstatSync(oldHandle.lockPath).isFile(), true);
    assert.equal(oldHandle.verifyStillHeld(), true);
    casePhase = "release-retry";
    oldHandle.release();
    absent(oldHandle.lockPath);
    result.completedAcquisitions += 1;
    casePhase = "acquire-fresh";
    const fresh = acquireFileLockSync(target, lockOptions());
    try {
      assert.equal(fresh.verifyStillHeld(), true);
      const bytes = fs.readFileSync(fresh.lockPath);
      casePhase = "old-handle-repeated-release";
      oldHandle.release();
      oldHandle.release();
      assert.equal(fresh.verifyStillHeld(), true);
      assert.deepEqual(fs.readFileSync(fresh.lockPath), bytes);
    } finally {
      fresh.release();
    }
    casePhase = "sidecar-absent";
    absent(fresh.lockPath);
    result.completedAcquisitions += 1;
    Object.assign(result, { outcome: "passed", firstReleaseError: "EACCES", retryRemoved: true, freshHolderPreserved: true });
  } catch (error) {
    Object.assign(result, { phase: casePhase, error: errorShape(error) });
  } finally {
    try { oldHandle?.release(); }
    catch (error) { Object.assign(result, { outcome: "failed", cleanupError: errorShape(error) }); }
  }
  return result;
}

async function runSuite() {
  const results = [];
  let directory;
  let failure;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-sidecar-contention-"));
    for (const test of cases) {
      const result = await runContentionCase(test, path.join(directory, test.name));
      results.push(result);
      emit(result);
    }
    const permission = runPermissionCase(path.join(directory, "permissions"));
    results.push(permission);
    emit(permission);
  } catch (error) {
    failure = errorShape(error);
  } finally {
    // runContentionCase never returns while any child can still mutate this root.
    try { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
    catch (error) { failure = errorShape(error); }
  }
  const permission = results.find((result) => result.case === "posix-release-retry");
  const failed = Boolean(failure) || results.length !== 5 || results.some((result) => result.outcome === "failed");
  emit({
    case: "summary", outcome: failed ? "failed" : permission.outcome === "skipped" ? "passed-with-skip" : "passed",
    contentionCases: cases.length, processesPerCase: processes,
    expectedContentionProcesses: cases.length * processes,
    launchedContentionProcesses: results.reduce((total, result) => total + (result.launchedProcesses ?? 0), 0),
    acquisitionsPerProcess, expectedContentionAcquisitions: cases.length * processes * acquisitionsPerProcess,
    completedContentionAcquisitions: results.filter((result) => result.case !== "posix-release-retry")
      .reduce((total, result) => total + result.completedAcquisitions, 0),
    permissionCase: { outcome: permission?.outcome ?? "not-run", reason: permission?.reason },
    ...(failure ? { error: failure } : {}),
  });
  if (failed) process.exitCode = 1;
}

try {
  assert.ok(["off", "auto", "require"].includes(mode));
  assert.ok(worker ? process.argv.length === 6 && process.send : process.argv.length <= 3);
  // Self-package resolution exercises dist through the same exports as an installed consumer.
  ({ root } = await import("@openclaw/fs-safe"));
  const { configureFsSafeNative } = await import("@openclaw/fs-safe/config");
  ({ acquireFileLock, acquireFileLockSync } = await import("@openclaw/fs-safe/file-lock"));
  configureFsSafeNative({ mode });
  if (worker) {
    const test = cases.find((candidate) => candidate.name === process.argv[4]);
    assert.ok(test);
    await runWorker(test, process.argv[5]);
    console.log(JSON.stringify({ outcome: "passed", completed }));
  } else {
    await runSuite();
  }
} catch (error) {
  const report = { outcome: "failed", phase, completed, error: errorShape(error) };
  if (worker) console.log(JSON.stringify(report));
  else emit({ case: "summary", ...report, usage: "node scripts/sidecar-contention-proof.mjs off|auto|require" });
  process.exitCode = 1;
} finally {
  if (worker && process.connected) process.disconnect();
}
