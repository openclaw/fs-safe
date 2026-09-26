import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate as immediate } from "node:timers/promises";
import { getNativeBinding } from "../dist/native.js";

assert.equal(process.platform, "darwin", "this allocation regression uses macOS leaks");
assert.equal(typeof global.gc, "function", "launch Node with --expose-gc");
assert.equal(process.env.MallocStackLogging, "1", "enable allocation stacks before starting Node");
const run = promisify(execFile);
const binding = getNativeBinding();
assert.equal(typeof binding?.watchRegister, "function", "build the native addon first");
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-cleanup-leak-")));
const output = path.resolve(".artifacts/watch-cleanup-leaks");
await fs.mkdir(output, { recursive: true });
const toolEnv = { ...process.env };
delete toolEnv.MallocStackLogging;
delete toolEnv.MallocStackLoggingNoCompact;
async function sample(cycles) {
  global.gc(); await immediate(); global.gc();
  let report;
  try {
    const result = await run("/usr/bin/leaks", ["--quiet", "--fullStacks", String(process.pid)],
      { env: toolEnv, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    report = result.stdout + result.stderr;
  } catch (error) {
    if (error.code !== 1) throw error;
    report = String(error.stdout ?? "") + String(error.stderr ?? "");
  }
  await fs.writeFile(path.join(output, `cycles-${cycles}.txt`), report);
  const match = report.match(/Process \d+: (\d+) leaks for (\d+) total leaked bytes/);
  assert.ok(match, "leaks did not produce an allocation result");
  assert.equal(binding.watchThreadCount(), 0);
  const result = { cycles, leaks: Number(match[1]), leakedBytes: Number(match[2]) };
  process.stdout.write(JSON.stringify(result) + "\n");
  return result;
}
try {
  const baseline = await sample(0);
  const checkpoints = [];
  const callback = () => {};
  for (let cycle = 1; cycle <= 1000; cycle++) {
    const id = binding.watchRegister(directory, 256, callback);
    binding.watchUnregister(id);
    await immediate();
    if (cycle === 100 || cycle === 1000) checkpoints.push(await sample(cycle));
  }
  for (const result of checkpoints) {
    assert.equal(result.leakedBytes, baseline.leakedBytes, `native leaks grew after ${result.cycles} watch cycles`);
    assert.equal(result.leaks, baseline.leaks);
  }
} finally { await fs.rm(directory, { recursive: true, force: true }); }
