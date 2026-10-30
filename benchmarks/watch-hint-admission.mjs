// Post-scan admission only: synthetic transport, real guards, compiled worker I/O.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const dist = path.resolve(process.argv[2] ?? "dist");
const load = name => import(pathToFileURL(path.join(dist, name + ".js")));
const { root } = await load("root");
const { rootHandleContext } = await load("root-handle-context");
const { scanWatch, watchScopes } = await load("watch-scan");
const { admittedNativeChanges } = await load("watch-hints");
const { createWatchIo, enableWatchIoDiagnostics, watchIoMetrics } = await load("watch-io");
const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "watch-admission-")));
let close;
try {
  await fsp.mkdir(path.join(base, "selected"));
  await fsp.mkdir(path.join(base, "noise"));
  await fsp.writeFile(path.join(base, "selected", "config"), "{}");
  const context = rootHandleContext(await root(base));
  enableWatchIoDiagnostics();
  close = createWatchIo(context, true);
  const scopes = watchScopes([{ path: path.join("selected", "config"), kind: "entry" }]);
  const signal = new AbortController().signal;
  const snapshot = await scanWatch(context, scopes, {
    maxEntries: 100, maxDirectories: 100, maxPendingPaths: 256, admitting: true,
  }, signal, async () => {});
  const batch = { overflow: false, hints: Array.from({ length: 128 }, (_, n) =>
    ({ directory: "noise", name: `gone-${n}`, event: "rename" })) };
  const admit = () => admittedNativeChanges(context, scopes, snapshot, snapshot, batch, signal, 256);
  await admit();
  for (let sample = 0; sample < 7; sample++) {
    const before = await watchIoMetrics();
    let hostCalls = 0;
    const originals = new Map();
    for (const name of ["lstatSync", "statSync", "realpathSync", "openSync", "fstatSync", "closeSync", "readlinkSync"]) {
      const original = fs[name]; originals.set(name, original);
      fs[name] = Object.assign(function (...args) { hostCalls++; return Reflect.apply(original, this, args); }, original);
    }
    const nativeRealpath = fs.realpathSync.native;
    fs.realpathSync.native = (...args) => { hostCalls++; return nativeRealpath(...args); };
    const loop = performance.eventLoopUtilization();
    const cpu = process.cpuUsage();
    const started = performance.now();
    let changes;
    try { changes = await admit(); }
    finally { for (const [name, original] of originals) fs[name] = original; }
    const wallMs = performance.now() - started;
    const mainActiveMs = performance.eventLoopUtilization(loop).active;
    const used = process.cpuUsage(cpu);
    const after = await watchIoMetrics();
    console.log(JSON.stringify({ sample, hints: batch.hints.length, changes: changes?.length,
      hostSyncCalls: hostCalls, wallMs, mainActiveMs, processCpuMs: (used.user + used.system) / 1000,
      workerCalls: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - (before[key] ?? 0)])) }));
  }
} finally {
  await close?.();
  await fsp.rm(base, { recursive: true, force: true });
}
