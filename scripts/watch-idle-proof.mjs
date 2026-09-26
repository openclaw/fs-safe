import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { root } from "../dist/root.js";
import { watch } from "../dist/watch.js";
import { getNativeBinding } from "../dist/native.js";

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = process.argv.includes("--baseline");
const windowsThreads = async () => JSON.parse((await exec("powershell.exe", ["-NoProfile", "-Command",
  `ConvertTo-Json -Compress -InputObject @((Get-Process -Id ${process.pid}).Threads | ForEach-Object { @{ id = $_.Id; ticks = $_.TotalProcessorTime.Ticks } })`,
])).stdout);
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-idle-")));
assert.ok(!directory.includes("/claude-501/"), "proof requires normal temporary storage");
const admitted = await root(directory);
const prior = process.platform === "win32" ? await windowsThreads() : [];
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
    const before = (await windowsThreads()).filter(thread => !prior.some(old => old.id === thread.id));
    assert.equal(before.length, 1, "expected precisely one new native hub thread");
    await sleep(10_000);
    const after = (await windowsThreads()).find(thread => thread.id === before[0].id);
    assert.ok(after, "hub thread remains alive while subscribed");
    measurement = { hubThreadId: after.id, hubCpuMs: (after.ticks - before[0].ticks) / 10_000 };
  }
  console.log(JSON.stringify({ proof: "watch-idle", platform: process.platform, mode: "events", baseline,
    elapsedMs: performance.now() - started, processCpuMicros: process.cpuUsage(cpu), ...measurement }));
} finally {
  await owner.close();
  assert.equal(getNativeBinding().watchThreadCount(), 0);
  await fs.rm(directory, { recursive: true, force: true });
}
