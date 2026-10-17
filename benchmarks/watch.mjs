import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

export async function registerWatch({ api, workspace, register, contract }) {
  if (typeof api.watch !== "function") return;
  const directory = path.join(workspace, "watch-lifecycle");
  await fs.mkdir(directory);
  const root = await api.root(directory);
  const initial = api.watch(root, { mode: "poll", scopes: [], onInvalidate() {} });
  try { contract("WatchSubscription", initial); await initial.ready; }
  finally { await initial.close(); }
  register("watch/poll-lifecycle", async () => {
    const owner = api.watch(root, { mode: "poll", scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
    try {
      await owner.ready;
      await owner.setScopes([{ path: "file", kind: "entry" }]);
      await owner.reconcile();
      assert.equal(owner.health().state, "ready");
    } finally { await owner.close(); }
    await owner[Symbol.asyncDispose]();
    assert.equal(owner.health().directories, 0);
  }, { covers: ["watch", "WatchSubscription.setScopes", "WatchSubscription.reconcile", "WatchSubscription.health", "WatchSubscription.close", "WatchSubscription.[Symbol.asyncDispose]"],
    workloadSemantics: "Guarded polling lifecycle and joined retirement; no event-throughput claim." });
}

// Standalone steady-state probe; setup/admission is excluded from each sample.
export async function measureIdleWatch({ api, directories, mode, ticks = 3, intervalMs = 20, trace = false }) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-watch-idle-"));
  const counts = {};
  const restore = [];
  let counting = false;
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  api.enableWatchIoDiagnostics?.();
  for (const [target, methods, prefix] of [
    [fsSync, ["lstatSync", "statSync", "realpathSync", "openSync", "closeSync", "fstatSync", "readlinkSync"], "sync."],
    [fs, ["lstat", "stat", "realpath", "opendir", "readdir", "open"], "async."],
    [fsSync.Dir.prototype, ["readSync", "read", "closeSync", "close"], "dir."],
    [fsSync.realpathSync, ["native"], "realpath."],
  ]) for (const method of methods) {
    const original = target[method];
    target[method] = function (...args) {
      if (counting) counts[prefix + method] = (counts[prefix + method] ?? 0) + 1;
      return Reflect.apply(original, this, args);
    };
    Object.assign(target[method], original);
    restore.push(() => { target[method] = original; });
  }
  let owner;
  try {
    // Three files per directory approximates the reporter's 11,139 / 3,828 tree.
    for (let start = 1; start < directories; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, directories - start) }, async (_, offset) => {
        const index = start + offset;
        const directory = path.join(workspace, `d${Math.floor((index - 1) / 64)}`, `d${index}`);
        await fs.mkdir(directory, { recursive: true });
        for (let file = 0; file < 3; file++) await fs.writeFile(path.join(directory, `f${file}`), "fixture");
      }));
    }
    const root = await api.root(workspace);
    const samples = [];
    let started, cpu, workerBefore;
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timeout = setTimeout(() => reject(new Error("idle watch benchmark timed out")), 1_800_000);
    let admitted = false, sampleAfter = Infinity;
    owner = api.watch(root, {
      mode, scopes: [{ path: "", kind: "tree" }], intervalMs,
      maxDirectories: directories * 2, maxEntries: directories * 8,
      onInvalidate() {},
      onHealth(health) {
        if (health.state === "unavailable") reject(health.failure.error);
        if (admitted && performance.now() >= sampleAfter && health.state === "reconciling") {
          if (trace) process.stderr.write("WATCH_TICK_BEGIN\n");
          for (const key of Object.keys(counts)) delete counts[key];
          started = performance.now(); cpu = process.cpuUsage(); counting = true;
          delay.reset();
          workerBefore = api.watchIoMetrics?.();
        } else if (health.state === "ready") {
          if (counting) {
            counting = false;
            const usage = process.cpuUsage(cpu);
            const sample = { wallMs: performance.now() - started, cpuMs: (usage.user + usage.system) / 1000,
              calls: { ...counts }, mainThreadCalls: Object.values(counts).reduce((a, b) => a + b, 0) };
            const beforeMetrics = workerBefore, workerAfter = api.watchIoMetrics?.();
            if (trace) process.stderr.write("WATCH_TICK_END\n");
            // Let the monitor record the final executing slice before reading it.
            setTimeout(async () => {
              try {
                sample.eventLoopMaxMs = delay.max / 1e6;
                sample.eventLoopP99Ms = delay.percentile(99) / 1e6;
                const before = await beforeMetrics ?? {}, after = await workerAfter ?? {};
                sample.workerCalls = Object.fromEntries(Object.entries(after).map(([key, count]) => [key, count - (before[key] ?? 0)]));
                sample.totalCalls = sample.mainThreadCalls + Object.values(sample.workerCalls).reduce((a, b) => a + b, 0);
                samples.push(sample);
                if (samples.length === ticks) resolve();
              } catch (error) { reject(error); }
            }, 1);
          }
          if (!admitted) sampleAfter = performance.now() + 1100;
          admitted = true;
        }
      },
    });
    try { await owner.ready; await done; }
    finally { clearTimeout(timeout); }
    return { requestedDirectories: directories, directories: owner.health().directories,
      mode: owner.health().mode, platform: process.platform, node: process.version,
      load: os.loadavg(), cpus: os.availableParallelism(), samples };
  } finally {
    counting = false;
    delay.disable();
    await owner?.close();
    for (const undo of restore.reverse()) undo();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1];
  const dist = value("dist") ?? path.resolve("dist");
  const { root } = await import(pathToFileURL(path.join(dist, "root.js")));
  const { watch } = await import(pathToFileURL(path.join(dist, "watch.js")));
  let diagnostics = {};
  try { diagnostics = await import(pathToFileURL(path.join(dist, "watch-io.js"))); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
  for (const directories of (value("sizes") ?? "500,4000,20000").split(",").map(Number)) {
    console.log(JSON.stringify(await measureIdleWatch({ api: { root, watch, ...diagnostics }, directories,
      mode: value("mode") ?? "poll", ticks: Number(value("ticks") ?? 3), trace: process.argv.includes("--trace") })));
  }
}
