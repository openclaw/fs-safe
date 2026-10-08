// Run after building both checkouts: node test/watch-stream-benchmark.mjs /path/to/base
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";

const base = path.resolve(process.argv[2] ?? ".");
const load = file => import(pathToFileURL(file).href);
const { NativeWatchBackend: Before } = await load(path.join(base, "dist/watch-native.js"));
const { watchStreamPaths } = await load(path.join(base, "dist/watch-stream.js"));
const { NativeWatchBackend: After } = await import("../dist/watch-native.js");
const scopes = Array.from({ length: 128 }, (_, n) => ({ path: `tree-${n}`, kind: "tree", depth: 8 }));
const directoryPaths = new Map(scopes.map(scope => [scope.path, path.resolve("fixture", scope.path)]));
let reads = 0;
const snapshot = { get directoryPaths() { reads++; return directoryPaths; }, excludedDirectories: new Map() };
const binding = { watchRegister: () => 1, watchUnregister() {} };
const before = new Before(binding, { rootReal: path.resolve("fixture") }, () => {}, 256, false);
const after = new After(binding, { rootReal: path.resolve("fixture") }, () => {}, 256, false);
const original = Object.getOwnPropertyDescriptor(process, "platform");
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  Object.defineProperty(process, "platform", { value: "win32" });
  const a = () => before.configure(watchStreamPaths(snapshot, scopes));
  const b = () => after.configure(snapshot, scopes);
  const measure = fn => {
    const started = performance.now();
    for (let n = 0; n < 2000; n++) fn();
    return performance.now() - started;
  };
  for (let n = 0; n < 100; n++) { a(); b(); }
  for (const [name, right] of [["A/A", a], ["A/B", b]]) {
    const leftTimes = [], rightTimes = [];
    for (let n = 0; n < 7; n++) {
      leftTimes.push(measure(a)); rightTimes.push(measure(right));
      rightTimes.push(measure(right)); leftTimes.push(measure(a));
    }
    console.log(JSON.stringify({ name, beforeMs: median(leftTimes), afterMs: median(rightTimes), ratio: median(rightTimes) / median(leftTimes), iterations: 2000 }));
  }
  reads = 0; a(); const beforeReads = reads;
  reads = 0; b(); console.log(JSON.stringify({ directoryPathReads: { before: beforeReads, after: reads }, scopes: scopes.length }));
} finally {
  Object.defineProperty(process, "platform", original);
  before.close(); after.close();
}
