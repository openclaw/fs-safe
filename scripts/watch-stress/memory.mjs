import v8 from "node:v8";
import { mkdirSync, appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { setImmediate as immediate } from "node:timers/promises";
import { assert, fs, path, delay, fixture, observe, populate, cleanup, diagnostics } from "./oracle.mjs";
import { resources, exec } from "./metrics.mjs";
import { burst } from "./workloads.mjs";
import { manualInvalidations } from "./memory-control.mjs";
import { getNativeBinding } from "../../dist/native.js";

const { values } = parseArgs({ options: {
  arm: { type: "string" }, minutes: { type: "string", default: "30" },
  gc: { type: "string", default: "checkpoint" }, output: { type: "string" },
  snapshots: { type: "boolean", default: false }, tools: { type: "boolean", default: false },
  smoke: { type: "boolean", default: false },
} });
const arm = values.arm;
assert.ok(["none", "poll", "events", "lifecycle", "steady"].includes(arm));
assert.ok(["checkpoint", "none"].includes(values.gc));
const minutes = values.smoke ? 6 : Number(values.minutes);
assert.ok(values.smoke || [30, 60].includes(minutes));
assert.equal(typeof global.gc, "function", "launch with node --expose-gc");
process.env.NODE_ENV = "test";
const checkpointMs = values.smoke ? 1000 : 60_000;
const output = path.resolve(values.output ?? `.artifacts/memory/${arm}-${values.gc}`);
mkdirSync(output, { recursive: true });
const emit = record => { const line = JSON.stringify(record) + "\n"; appendFileSync(path.join(output, "memory.jsonl"), line); process.stdout.write(line); };
const binding = getNativeBinding();
assert.equal(typeof binding.watchMemoryStats, "function", "build the instrumented addon before memory diagnostics");
const f = await fixture("memory-" + arm), start = performance.now();
let main, control, edits = 0, operations = 0, cycles = 0, bursts = 0;
const reads = { lists: 0, files: 0, bytes: 0 };
const list = f.capability.list.bind(f.capability), read = f.capability.readBytes.bind(f.capability);
f.capability.list = (...args) => { reads.lists++; return list(...args); };
f.capability.readBytes = async (...args) => { const bytes = await read(...args); reads.files++; reads.bytes += bytes.length; return bytes; };
const failures = [];
process.on("unhandledRejection", error => { failures.push(String(error?.stack ?? error)); });

function observeArm(scopes) {
  let manual;
  const mode = arm === "poll" ? "poll" : "events";
  const observer = observe(f, { mode, ...(scopes ? { scopes } : {}) }, arm === "none" || (arm === "lifecycle" && !scopes)
    ? (capability, options) => { manual = manualInvalidations(capability, options); return manual; } : undefined);
  return { observer, manual };
}
async function sample(minute, phase = "checkpoint") {
  await immediate(); await immediate();
  const native = binding.watchMemoryStats();
  const counts = await resources();
  const beforeGc = process.memoryUsage();
  if (values.gc === "checkpoint") { global.gc(); await immediate(); global.gc(); }
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const heapSpaces = v8.getHeapSpaceStatistics();
  let smaps;
  if (process.platform === "linux") {
    const rollup = await fs.readFile("/proc/self/smaps_rollup", "utf8");
    smaps = Object.fromEntries([...rollup.matchAll(/^([A-Za-z_]+):\s+(\d+) kB$/gm)].map(([, key, value]) => [key, Number(value) * 1024]));
  }
  const record = { phase, arm, gc: values.gc, minute, elapsedSeconds: (performance.now() - start) / 1000,
    pid: process.pid, node: process.version, platform: process.platform, arch: process.arch, smoke: values.smoke,
    allocator: process.env.WATCH_MEMORY_ALLOCATOR ?? "system", arenaMax: process.env.MALLOC_ARENA_MAX ?? null,
    beforeGc, ...memory, heapPhysical: heap.total_physical_size, heapMalloced: heap.malloced_memory, heapSpaces, smaps,
    handles: counts.handles, native, reads: { ...reads }, edits, operations, cycles, bursts,
    oracle: main ? { ...main.metrics, lastConsumerReadError: main.metrics.lastConsumerReadError?.code } : null,
    cleanupErrors: diagnostics.cleanupErrors.length, unhandled: failures.length };
  emit(record);
  if (values.snapshots && [5, 30].includes(minute)) {
    const snapshot = path.join(output, `${phase}-${minute}.heapsnapshot`);
    v8.writeHeapSnapshot(snapshot);
    emit({ phase: "heap-snapshot", arm, minute, file: path.basename(snapshot) });
  }
  if (values.tools && process.platform === "darwin" && [5, 30, 60].includes(minute)) {
    for (const [tool, args] of [["vmmap", ["--summary", String(process.pid)]], ["leaks", [String(process.pid)]]]) {
      try {
        const result = await exec(tool, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
        await fs.writeFile(path.join(output, `${tool}-${phase}-${minute}.txt`), result.stdout + result.stderr);
      } catch (error) {
        await fs.writeFile(path.join(output, `${tool}-${phase}-${minute}.txt`), String(error.stdout ?? "") + String(error.stderr ?? "") + `\nexit=${error.code}\n`);
        emit({ phase: "tool-status", arm, minute, tool, exit: error.code });
      }
    }
  }
}
try {
  await populate(f, 16, 8);
  await fs.writeFile(path.join(f.directory, "low-rate"), "initial");
  ({ observer: main, manual: control } = observeArm());
  await main.subscription.ready; await main.flush(); await sample(0, "baseline");
  const workStart = performance.now();
  for (let minute = 1; minute <= minutes; minute++) {
    const deadline = workStart + minute * checkpointMs;
    if (arm !== "lifecycle" && minute % 5 === 0) {
      operations += await burst(f, minute, () => control?.mark()); bursts++;
    }
    while (performance.now() < deadline) {
      if (arm !== "lifecycle") {
        await fs.writeFile(path.join(f.directory, "low-rate"), `edit-${++edits}`);
        control?.mark([{ path: "low-rate", type: "content" }]);
      }
      if (arm !== "steady") {
        let peer = observeArm([{ path: "low-rate", kind: "entry" }]).observer;
        try { await peer.subscription.ready; await peer.checkpoint(); cycles++; }
        finally { await peer.close(); peer = undefined; }
      } else await delay(300);
      await delay(Math.min(values.smoke ? 10 : 1000, Math.max(0, deadline - performance.now())));
    }
    await main.checkpoint();
    await sample(minute);
    assert.equal(failures.length, 0); assert.equal(diagnostics.cleanupErrors.length, 0);
  }
  await main.close(); main = undefined; control = undefined;
  await sample(minutes, "closed");
  const native = binding.watchMemoryStats();
  assert.equal(native.registrations, 0); assert.equal(native.pendingSets, 0);
  assert.equal(native.payloadsLive, 0); assert.equal(native.threadsafeFunctionsLive, 0);
} catch (error) {
  emit({ phase: "failure", arm, error: String(error?.stack ?? error) }); process.exitCode = 1;
} finally { await cleanup([() => main?.close()], [() => f.remove()]); }
if (failures.length || diagnostics.cleanupErrors.length) {
  emit({ phase: "failure", arm, unhandled: failures, cleanupErrors: diagnostics.cleanupErrors }); process.exitCode = 1;
}
if (!process.exitCode) emit({ phase: "complete", arm, gc: values.gc, minutes, smoke: values.smoke, checkpoints: minutes, native: binding.watchMemoryStats() });
