import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchSubscription } from "../src/watch.js";
import { NodeWatchBackend } from "../src/watch-node.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { configureFsSafeNative, getFsSafeNativeConfig } from "../src/config.js";
let dir: string;
let owners: WatchSubscription[];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-watch-life-")); owners = []; });
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  await Promise.allSettled(owners.map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});
const scopes = [{ path: "", kind: "tree" as const }];
async function inotifyInstances() {
  const descriptors = await fs.readdir("/proc/self/fd");
  let count = 0;
  for (const descriptor of descriptors) {
    const target = await fs.readlink("/proc/self/fd/" + descriptor).catch(() => "");
    if (target.includes("inotify")) count++;
  }
  return count;
}
it.skipIf(process.platform !== "linux")("joins the actual worker and returns inotify descriptors to baseline", async () => {
  const before = await inotifyInstances();
  const owner = watch(await root(dir), { scopes, onDirty() {} }); owners.push(owner);
  await owner.ready;
  expect(await inotifyInstances()).toBe(before + 1);
  await owner.close();
  expect(await inotifyInstances()).toBe(before);
  expect(owner.health().workers).toBe(0);
});
it("enrolls and joins close before startup", async () => {
  const owner = watch(await root(dir), { scopes, onDirty() { throw new Error("late callback"); } }); owners.push(owner);
  const closing = owner.close();
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  await closing;
  expect(owner.health()).toMatchObject({ state: "closed", directories: 0, workers: 0 });
});
it("retains callback failures and rejects asynchronous callbacks", async () => {
  const owner = watch(await root(dir), { scopes, onDirty: async () => {} }); owners.push(owner);
  await expect(owner.ready).rejects.toMatchObject({ code: "helper-failed" });
  expect(owner.health().failure?.operation).toBe("callback");
  const first = owner.close();
  expect(owner.close()).toBe(first);
  await expect(first).rejects.toMatchObject({ code: "helper-failed" });
});
it("reports watch acquisition errors separately and keeps them on joined close", async () => {
  const errors: unknown[] = [];
  const backend = new NodeWatchBackend(() => {}, error => { errors.push(error); }, true, 2);
  try {
    await expect(backend.add(path.join(dir, "absent"), "absent")).rejects.toMatchObject({ details: { operation: "watch", code: "ENOENT" } });
    expect(errors).toHaveLength(1);
  } finally {
    await expect(backend.close()).rejects.toMatchObject({ details: { operation: "watch", code: "ENOENT" } });
  }
});
it("honors native-off while providing Node observation", async () => {
  const previous = getFsSafeNativeConfig();
  configureFsSafeNative({ mode: "off" });
  try {
    const owner = watch(await root(dir), { scopes, onDirty() {} }); owners.push(owner);
    await owner.ready;
    expect(owner.health()).toMatchObject({ mode: "node", state: "ready" });
    expect(getFsSafeNativeConfig().mode).toBe("off");
    await owner.close();
  } finally { configureFsSafeNative(previous); }
});
it("bounds churn instead of ever declaring partial readiness", async () => {
  await fs.mkdir(path.join(dir, "tree"));
  let i = 0;
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async name => {
    if (name === path.join(dir, "tree")) {
      await fs.rename(name, path.join(dir, "retired" + ++i));
      await fs.mkdir(name);
    }
  } });
  const owner = watch(await root(dir), { scopes: [{ path: "tree", kind: "tree" }], maxPasses: 3, onDirty() {} }); owners.push(owner);
  await expect(owner.ready).rejects.toMatchObject({ code: "timeout" });
  expect(owner.health().state).toBe("unavailable");
  expect(i).toBe(3);
});
it("bounds worker and callback queues under a burst", async () => {
  const events: { reason: string; count: number | undefined }[] = [];
  const owner = watch(await root(dir), { scopes, maxPendingPaths: 2, onDirty: hint => { events.push({ reason: hint.reason, count: hint.changes?.length }); } }); owners.push(owner);
  await owner.ready;
  events.length = 0;
  await Promise.all(Array.from({ length: 60 }, (_, i) => fs.writeFile(path.join(dir, "file" + i), "x")));
  await expect.poll(() => events.some(event => event.reason === "overflow")).toBe(true);
  expect(events.every(event => event.count === undefined || event.count <= 2)).toBe(true);
  expect(owner.health().pendingInvalidations).toBeLessThanOrEqual(1);
  await owner.close();
});

it("cannot reopen when a scope accessor closes during target admission", async () => {
  const owner = watch(await root(dir), { scopes, onDirty() {} }); owners.push(owner);
  await owner.ready;
  const update = owner.update([{ get path() { void owner.close(); return "next"; }, kind: "entry" }]);
  await expect(update).rejects.toMatchObject({ name: "AbortError" });
  await owner.close();
  expect(owner.health()).toMatchObject({ state: "closed", workers: 0, directories: 0 });
});

it("retains an undefined exclusion failure instead of treating it as success", async () => {
  await fs.writeFile(path.join(dir, "file"), "value");
  const owner = watch(await root(dir), { mode: "poll", scopes, onDirty() {}, exclude() { throw undefined; } }); owners.push(owner);
  await expect(owner.ready).rejects.toMatchObject({ code: "helper-failed", details: { operation: "callback" } });
  expect(owner.health()).toMatchObject({ state: "unavailable", failure: { operation: "callback" } });
  await expect(owner.close()).rejects.toMatchObject({ code: "helper-failed" });
});
