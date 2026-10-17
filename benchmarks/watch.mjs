import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

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
    for (let index = 1; index < directories; index++) {
      const directory = path.join(workspace, `d${Math.floor((index - 1) / 64)}`, `d${index}`);
      await fs.mkdir(directory, { recursive: true });
      for (let file = 0; file < 3; file++) await fs.writeFile(path.join(directory, `f${file}`), "fixture");
    }
    const root = await api.root(workspace);
    const samples = [];
    let started, cpu;
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timeout = setTimeout(() => reject(new Error("idle watch benchmark timed out")), 1_800_000);
    let admitted = false;
    owner = api.watch(root, {
      mode, scopes: [{ path: "", kind: "tree" }], intervalMs,
      maxDirectories: directories * 2, maxEntries: directories * 8,
      onInvalidate() {},
      onHealth(health) {
        if (health.state === "unavailable") reject(health.failure.error);
        if (admitted && health.state === "reconciling") {
          if (trace) process.stderr.write("WATCH_TICK_BEGIN\n");
          for (const key of Object.keys(counts)) delete counts[key];
          started = performance.now(); cpu = process.cpuUsage(); counting = true;
        } else if (health.state === "ready") {
          if (counting) {
            counting = false;
            const usage = process.cpuUsage(cpu);
            samples.push({ wallMs: performance.now() - started, cpuMs: (usage.user + usage.system) / 1000,
              calls: { ...counts }, totalCalls: Object.values(counts).reduce((a, b) => a + b, 0) });
            if (trace) process.stderr.write("WATCH_TICK_END\n");
            if (samples.length === ticks) resolve();
          }
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
  for (const directories of (value("sizes") ?? "500,4000,20000").split(",").map(Number)) {
    console.log(JSON.stringify(await measureIdleWatch({ api: { root, watch }, directories,
      mode: value("mode") ?? "poll", ticks: Number(value("ticks") ?? 3), trace: process.argv.includes("--trace") })));
  }
}
