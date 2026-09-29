import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { root } from "../dist/root.js";
import { watch } from "../dist/watch.js";
import { getNativeBinding } from "../dist/native.js";

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = process.argv.includes("--baseline");
const windowsThreads = async () => JSON.parse((await exec("powershell.exe", [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
  fileURLToPath(new URL("watch-idle-threads.ps1", import.meta.url)), "-ProcessId", String(process.pid),
], { timeout: 30_000 })).stdout).filter(thread => thread.name === "fs-safe-watch");
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-idle-")));
assert.ok(!directory.includes("/claude-501/"), "proof requires normal temporary storage");
const admitted = await root(directory);
const owner = watch(admitted, { mode: "events", scopes: [{ path: "", kind: "tree" }], intervalMs: 60_000, onInvalidate() {} });
try {
  await owner.ready;
  assert.equal(owner.health().mode, "events");
  await sleep(3000); // Let fixture creation and initial delivery settle before sampling.
  const cpu = process.cpuUsage();
  const started = performance.now();
  let measurement;
  if (process.platform === "linux") {
    const sample = async () => {
      const result = {};
      for (const id of await fs.readdir(`/proc/${process.pid}/task`)) {
        const status = await fs.readFile(`/proc/${process.pid}/task/${id}/status`, "utf8");
        if (/^Name:\s+fs-safe-watch$/m.test(status)) result[id] = Number(status.match(/^voluntary_ctxt_switches:\s+(\d+)/m)[1]);
      }
      assert.equal(Object.keys(result).length, 1);
      return result;
    };
    const before = await sample();
    await sleep(10_000);
    const after = await sample();
    const switches = Object.entries(before).reduce((sum, [id, count]) => sum + after[id] - count, 0);
    measurement = { hubVoluntaryContextSwitches: switches };
    if (!baseline) assert.ok(switches <= 5, `idle hub woke ${switches} times`);
  } else if (process.platform === "darwin") {
    const result = await exec("top", ["-l", "2", "-s", "10", "-stats", "pid,idlew,cpu", "-pid", String(process.pid)]);
    console.log(result.stdout);
    measurement = { source: "top: second sample is the 10-second process idle-wakeup interval" };
  } else if (process.platform === "win32") {
    const before = await windowsThreads();
    assert.equal(before.length, 1, "expected precisely one fs-safe-watch hub thread");
    assert.equal(getNativeBinding().watchThreadCount(), 1, "native hub count agrees with OS census");
    await sleep(10_000);
    const after = await windowsThreads();
    assert.equal(after.length, 1, "expected precisely one fs-safe-watch hub thread after sampling");
    assert.equal(after[0].id, before[0].id, "hub thread remains alive while subscribed");
    assert.equal(after[0].created, before[0].created, "hub thread identity remains stable");
    assert.equal(getNativeBinding().watchThreadCount(), 1, "native hub count remains one");
    assert.ok(after[0].ticks >= before[0].ticks, "hub CPU time is monotonic");
    measurement = { hubThreadId: after[0].id, hubThreadName: after[0].name, hubCpuMs: (after[0].ticks - before[0].ticks) / 10_000 };
  }
  console.log(JSON.stringify({ proof: "watch-idle", platform: process.platform, mode: "events", baseline,
    elapsedMs: performance.now() - started, processCpuMicros: process.cpuUsage(cpu), ...measurement }));
} finally {
  await owner.close();
  assert.equal(getNativeBinding().watchThreadCount(), 0);
  await fs.rm(directory, { recursive: true, force: true });
}
