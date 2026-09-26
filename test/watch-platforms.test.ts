import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
const binding = watchBinding("auto");
const mac = it.skipIf(process.platform !== "darwin" || !binding);
const win = it.skipIf(process.platform !== "win32" || !binding);
let directory: string;
let owners: WatchSubscription[];
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-platform-")));
  if (process.platform === "darwin" && directory.includes("/claude-501/")) throw new Error("watch fixtures require normal os.tmpdir()");
  owners = [];
}, 30_000);
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  await Promise.all(owners.map(owner => owner.close()));
  await fs.rm(directory, { recursive: true, force: true });
}, 30_000);
async function observe(location = directory) {
  const invalidations: WatchInvalidation[] = [];
  let nativeEvent!: (path: string, flags: number) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, __, inject) => { nativeEvent = inject!; } });
  const owner = watch(await root(location), { mode: "auto", scopes: [{ path: "", kind: "tree" }], intervalMs: 60_000,
    onInvalidate: value => { invalidations.push(value); } });
  owners.push(owner); await owner.ready; expect(owner.health().mode).toBe("events");
  invalidations.length = 0;
  return { owner, invalidations, nativeEvent };
}
mac("maps FSEvents dropped/wrapped/unmount flags to whole-scope invalidation", async () => {
  await fs.writeFile(path.join(directory, "kept"), "data");
  const { invalidations, nativeEvent } = await observe();
  for (const flags of [0, 1, 2, 4, 8, 64, 128]) {
    invalidations.length = 0; nativeEvent(path.join(directory, "kept"), flags);
    await expect.poll(() => invalidations.some(value => value.reason === "overflow" && value.changes === undefined)).toBe(true);
  }
}, 30_000);
mac("admits inside FSEvents detail and discards outside and dotdot pathnames", async () => {
  await fs.writeFile(path.join(directory, "kept"), "data");
  const { invalidations, nativeEvent } = await observe();
  nativeEvent(path.join(directory, "kept"), 0x1000);
  await expect.poll(() => invalidations.length).toBeGreaterThan(0);
  expect(invalidations.flatMap(value => value.changes ?? []).every(change => change.path === "kept")).toBe(true);
  for (const outside of [directory + "-sibling/private", directory + "/../private", "/unadmitted/private"]) {
    invalidations.length = 0; nativeEvent(outside, 0x1000);
    await expect.poll(() => invalidations.some(value => value.reason === "overflow")).toBe(true);
    expect(invalidations.flatMap(value => value.changes ?? []).every(change => change.path === "kept")).toBe(true);
  }
}, 30_000);
mac("RootChanged forces guarded reconciliation and rejects a replacement Root", async () => {
  const location = path.join(directory, "authority"); await fs.mkdir(location);
  const { owner, invalidations, nativeEvent } = await observe(location);
  fsSync.renameSync(location, path.join(directory, "retired")); fsSync.mkdirSync(location);
  nativeEvent(location, 32);
  await expect.poll(() => owner.health().state).toBe("unavailable");
  expect(owner.health().failure?.error).toMatchObject({ code: "path-mismatch" });
  expect(invalidations).toEqual([]);
  await owner.close(); expect(binding!.watchThreadCount!()).toBe(0);
}, 30_000);
mac("detects a real Root rename from WatchRoot without manual reconciliation", async () => {
  const location = path.join(directory, "authority"); await fs.mkdir(location);
  const { owner } = await observe(location);
  await fs.rename(location, path.join(directory, "retired")); await fs.mkdir(location);
  await expect.poll(() => owner.health().state, { timeout: 5000 }).toBe("unavailable");
  expect(owner.health().failure?.error).toMatchObject({ code: "path-mismatch" });
}, 30_000);
win("observes deep edits using recursive RDCW and joins cancellation during recursive deletion", async () => {
  for (let cycle = 0; cycle < 3; cycle++) {
    const location = path.join(directory, String(cycle));
    await fs.mkdir(path.join(location, "a/b"), { recursive: true });
    const { owner, invalidations } = await observe(location);
    const started = performance.now();
    await fs.writeFile(path.join(location, "a/b/file"), "deep edit");
    await expect.poll(() => invalidations.length, { timeout: 950, interval: 10 }).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1000);
    await Promise.all([fs.rm(path.join(location, "a"), { recursive: true }), owner.close()]);
    expect(binding!.watchThreadCount!()).toBe(0);
  }
  console.log(JSON.stringify({ proof: "rdcw-recursive-delete-cancel-join", platform: process.platform, mode: "events", cycles: 3 }));
}, 30_000);

mac("retries a full native callback queue when JS consumes a batch, without another event", async () => {
  const batches: { overflow: boolean }[] = [];
  const id = binding!.watchRegister!(directory, 256, batch => { batches.push(batch); });
  try {
    // Keep JS blocked while the hub fills the one-batch TSFN queue and overflows it.
    for (let i = 0; i < 3; i++) {
      binding!.watchTestEvent!(id, path.join(directory, "kept"), 0x1000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    await expect.poll(() => batches.some(batch => batch.overflow), { timeout: 1000 }).toBe(true);
  } finally { binding!.watchUnregister!(id); }
  expect(binding!.watchThreadCount!()).toBe(0);
});
