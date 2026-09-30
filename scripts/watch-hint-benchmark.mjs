// Synthetic scheduling/allocation proof. Run against independently built baseline/candidate dist directories.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session } from "node:inspector/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [dist = "dist", secondsText = "60", transport = "injected"] = process.argv.slice(2);
const seconds = Number(secondsText);
assert.ok(Number.isSafeInteger(seconds) && seconds >= 1);
assert.ok(["injected", "native"].includes(transport));
process.env.NODE_ENV = "test";
const load = name => import(pathToFileURL(path.resolve(dist, `${name}.js`)));
const { root } = await load("root"), { watch } = await load("watch");
const { getNativeBinding } = await load("native");
const { configureFsSafeNative } = await load("native-config");
const { __setFsSafeTestHooksForTest: hooks } = await load("test-hooks");
configureFsSafeNative({ mode: "require" });
const binding = getNativeBinding(), register = binding.watchRegister;
assert.equal(typeof register, "function");
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-hint-benchmark-")));
let owner, emit, visits = 0, passes = 0, invalidations = 0;
const session = new Session(); session.connect();
const allocation = node => node.selfSize + node.children.reduce((sum, child) => sum + allocation(child), 0);
async function measure(scenario, action) {
  visits = 0; passes = 0; invalidations = 0;
  global.gc?.();
  await session.post("HeapProfiler.startSampling", { samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const start = performance.now();
  await action();
  const elapsedMs = performance.now() - start;
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sampledBytes = allocation(profile.head);
  console.log(JSON.stringify({ scenario, transport, platform: process.platform, node: process.version,
    watchedFiles: 502, unrelatedSiblings: 20_000, elapsedMs, passes, visits, invalidations,
    visitsPerPass: passes ? visits / passes : 0, sampledBytes,
    sampledBytesPerPass: passes ? sampledBytes / passes : 0, passesPerMinute: passes * 60_000 / elapsedMs }));
}
async function injected(hints) {
  const prior = passes;
  emit({ hints, overflow: false });
  for (let i = 0; i < 500 && passes === prior; i++) await delay(10);
  assert.ok(passes > prior, "event did not complete a scan");
}
try {
  for (let i = 0; i < 10; i++) {
    await fs.mkdir(path.join(directory, "memory", `d${i}`), { recursive: true });
    await Promise.all(Array.from({ length: 50 }, (_, j) => fs.writeFile(path.join(directory, "memory", `d${i}`, `f${j}`), "memory")));
  }
  for (let i = 0; i < 20_000; i += 64) await Promise.all(Array.from({ length: Math.min(64, 20_000 - i) }, (_, j) => fs.writeFile(path.join(directory, `sibling-${i + j}`), "unrelated")));
  for (const name of ["MEMORY.md", "USER.md"]) await fs.writeFile(path.join(directory, name), "entry");
  // Avoid measuring fixture creation notifications as edits.
  await delay(3000);
  if (transport === "injected") binding.watchRegister = (name, limit, _callback, persistent) => register(name, limit, () => {}, persistent);
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  owner = watch(await root(directory), { mode: "events",
    scopes: [{ path: "MEMORY.md", kind: "entry" }, { path: "USER.md", kind: "entry" }, { path: "memory", kind: "tree", depth: 128 }],
    exclude() { visits++; return false; }, onInvalidate() { invalidations++; },
    onHealth(health) { if (health.state === "ready") passes++; },
  });
  await owner.ready; await delay(200);
  await measure("unchanged-full", async () => { for (let i = 0; i < 10; i++) await owner.reconcile(); });
  if (transport === "injected") {
    await measure("relevant-directory", async () => {
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(directory, "memory/d0/f0"), `edit-${i}`);
        await injected([{ directory: path.join("memory", "d0"), name: "f0", event: "change" }]);
      }
    });
    await measure("no-detail", async () => { for (let i = 0; i < 5; i++) await injected([]); });
  }
  await measure("unrelated-2-per-second", async () => {
    const start = performance.now();
    for (let i = 0; i < seconds * 2; i++) {
      if (transport === "native") {
        await fs.writeFile(path.join(directory, "atomic-save"), `unrelated-${i}`);
        await fs.rename(path.join(directory, "atomic-save"), path.join(directory, "sibling-0"));
      } else {
        await fs.writeFile(path.join(directory, "sibling-0"), `unrelated-${i}`);
        emit({ hints: [{ directory: "", name: "sibling-0", event: "change" }], overflow: false });
      }
      await delay(Math.max(0, start + (i + 1) * 500 - performance.now()));
    }
    await delay(100);
    for (let i = 0; i < 1000 && owner.health().state === "reconciling"; i++) await delay(10);
    assert.equal(owner.health().state, "ready", "periodic reconciliation did not finish");
    assert.equal(invalidations, 0, "unrelated load invalidated selected scopes");
  });
} finally {
  hooks(); await owner?.close(); binding.watchRegister = register; session.disconnect();
  await fs.rm(directory, { recursive: true, force: true });
}
