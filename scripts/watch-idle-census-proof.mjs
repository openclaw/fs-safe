// Verify native Windows hub attribution while unrelated Node workers remain live.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

assert.equal(process.platform, "win32", "this fixture requires actual Windows");
assert.ok(process.argv[2], "pass the repository path");
const repo = path.resolve(process.argv[2]);
const load = name => import(pathToFileURL(path.join(repo, "dist", name)).href);
const { root } = await load("root.js");
const { watch } = await load("watch.js");
const { getNativeBinding } = await load("native.js");
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sample = async () => JSON.parse((await exec("powershell.exe", [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
  path.join(repo, "scripts", "watch-idle-threads.ps1"), "-ProcessId", String(process.pid),
], { timeout: 30_000 })).stdout);
const hubs = threads => threads.filter(thread => thread.name === "fs-safe-watch");
const identity = thread => `${thread.id}:${thread.created}`;
const select = threads => {
  const selected = hubs(threads);
  assert.equal(selected.length, 1, "exactly one OS-described hub is required");
  assert.equal(getNativeBinding().watchThreadCount(), 1, "exactly one native hub is required");
  return selected[0];
};

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-census-control-")));
const workers = [];
let owner;
const watchdog = setTimeout(() => {
  console.error("Windows thread census fixture exceeded 90 seconds");
  process.exit(1);
}, 90_000);
try {
  const admitted = await root(directory);
  const prior = await sample();
  assert.equal(hubs(prior).length, 0);
  assert.equal(getNativeBinding().watchThreadCount(), 0);
  const priorIds = new Set(prior.map(thread => thread.id));
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      setInterval(() => {}, 60_000);
      parentPort.postMessage("ready");
    `, { eval: true, name: `watch-census-control-${index}` });
    workers.push(worker);
    await once(worker, "message");
  }
  const unrelated = await sample();
  assert.equal(hubs(unrelated).length, 0, "live unrelated Node workers must not be selected as hubs");
  assert.ok(unrelated.filter(thread => !priorIds.has(thread.id)).length >= 2,
    "the control must actually introduce new OS thread ids after the baseline");
  owner = watch(admitted, {
    mode: "events", scopes: [{ path: "", kind: "tree" }], intervalMs: 60_000, onInvalidate() {},
  });
  await owner.ready;
  assert.equal(owner.health().mode, "events");
  await sleep(3000);
  const beforeAll = await sample();
  const before = select(beforeAll);
  const oldCandidateCount = beforeAll.filter(thread => !priorIds.has(thread.id)).length;
  assert.ok(oldCandidateCount > 1, "the old all-new-thread census must fail this controlled scenario");
  await sleep(10_000);
  const after = select(await sample());
  assert.equal(identity(after), identity(before), "the actual hub remains sampled through the interval");
  assert.ok(after.ticks >= before.ticks, "CPU time belongs to the same live thread");
  await owner.close();
  assert.equal(getNativeBinding().watchThreadCount(), 0);
  const closed = await sample();
  assert.equal(hubs(closed).length, 0, "unrelated workers must not hide hub cleanup");
  assert.ok(workers.every(worker => worker.threadId !== -1), "control workers remain live after hub close");
  console.log(JSON.stringify({
    proof: "windows-watch-thread-census-control", controlWorkers: workers.length,
    oldCandidateCount, sampledHubCount: 1, hubThreadId: after.id, hubThreadName: after.name,
    hubCpuMs: (after.ticks - before.ticks) / 10_000, hubThreadsAfterClose: 0,
  }));
} finally {
  try {
    await owner?.close();
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    await fs.rm(directory, { recursive: true, force: true });
    clearTimeout(watchdog);
  }
}
