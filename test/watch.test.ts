import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";
import { getNativeBinding } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { configureFsSafeNative, getFsSafeNativeConfig } from "../src/config.js";
const eventsAvailable = !!watchBinding("auto");
if (process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !eventsAvailable) throw new Error("native watch events proof requires the freshly built addon");
const requiredEvents = process.env.FS_SAFE_TEST_WATCH_EVENTS === "1";
let executedEventCases = 0;
let latencyProof = false;
afterAll(() => {
  if (requiredEvents) {
    expect(executedEventCases).toBe(5);
    expect(latencyProof).toBe(true);
    console.log(JSON.stringify({ proof: "watch-events-suite", platform: process.platform, mode: "events", cases: executedEventCases }));
  }
});
const scopes = [{ path: "", kind: "tree" as const }];
let eventFixtures: string;
let dir: string;
beforeAll(async () => {
  eventFixtures = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-events-fixture-")));
  await fs.mkdir(path.join(eventFixtures, "latency"));
  await fs.mkdir(path.join(eventFixtures, "burst"));
  await fs.writeFile(path.join(eventFixtures, "latency/file"), "before");
  // FSEvents can coalesce creation and a later edit under a pre-subscription event ID.
  if (process.platform === "darwin") await new Promise(resolve => setTimeout(resolve, 3000));
});
afterAll(async () => { await fs.rm(eventFixtures, { recursive: true, force: true }); });
let owners: WatchSubscription[];
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-"))); owners = []; if (process.platform === "darwin" && dir.includes("/claude-501/")) throw new Error("watch fixtures must use normal os.tmpdir()"); });
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  await Promise.all(owners.map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});
function own(owner: WatchSubscription) { owners.push(owner); return owner; }

it("reconciles entry vs tree, depth and directory metadata without native hints", async () => {
  await fs.mkdir(path.join(dir, "tree/child/deep"), { recursive: true, mode: 0o700 });
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "poll", scopes: [{ path: "tree/", kind: "entry" }], onInvalidate: value => { changes.push(value); } }));
  await owner.ready;
  expect(changes).toEqual([{ reason: "reconcile", changes: undefined }]);
  changes.length = 0;
  await fs.writeFile(path.join(dir, "tree/child/file"), "x");
  await owner.reconcile();
  expect(changes).toHaveLength(0);
  await owner.setScopes([{ path: "tree", kind: "tree", depth: 1 }]);
  expect(changes.at(-1)).toEqual({ reason: "reconcile", changes: undefined });
  changes.length = 0;
  await fs.writeFile(path.join(dir, "tree/top"), "x");
  await owner.reconcile();
  expect(changes.some(value => value.changes?.some(change => change.path === path.join("tree", "top")))).toBe(true);
  if (process.platform !== "win32") {
    await owner.setScopes([{ path: "", kind: "entry" }]); changes.length = 0;
    await fs.chmod(dir, 0o750); await owner.reconcile();
    expect(changes.some(value => value.changes?.some(change => change.path === ""))).toBe(true);
  }
}, 30_000);
it("does not follow symlink entries while reconciling", async () => {
  await fs.mkdir(path.join(dir, "target"));
  await fs.symlink(path.join(dir, "target"), path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "poll", scopes: [{ path: "link", kind: "tree" }], onInvalidate: v => { changes.push(v); } }));
  await owner.ready; changes.length = 0;
  await fs.writeFile(path.join(dir, "target/file"), "private"); await owner.reconcile();
  expect(changes).toHaveLength(0);
}, 30_000);

describe.each(["events", "poll"] as const)("watch %s", mode => {
  const test = it.skipIf(mode === "events" && !eventsAvailable);
  beforeEach(() => { if (mode === "events") executedEventCases++; });
  test("rejects symbolic parents", async () => {
    await fs.mkdir(path.join(dir, "target"));
    await fs.symlink(path.join(dir, "target"), path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    const invalid = own(watch(await root(dir), { mode, scopes: [{ path: "link/file", kind: "entry" }], onInvalidate() {} }));
    await expect(invalid.ready).rejects.toMatchObject({ code: "symlink" });
  }, 30_000);
  test("fails observation without adopting a replacement Root", async () => {
    const name = path.join(dir, "authority"); await fs.mkdir(name);
    const changes: WatchInvalidation[] = [];
    const owner = own(watch(await root(name), { mode, scopes, onInvalidate: v => { changes.push(v); } }));
    await owner.ready; changes.length = 0;
    await fs.rename(name, path.join(dir, "old")); await fs.mkdir(name);
    await fs.writeFile(path.join(name, "outside-name"), "secret");
    await expect(owner.reconcile()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(owner.health()).toMatchObject({ state: "unavailable", failure: { operation: "scan" } });
    expect(changes).toHaveLength(0);
    await expect(owner.close()).resolves.toBeUndefined();
  }, 30_000);
  test("discovers missing targets and retires removed directory registrations", async () => {
    const owner = own(watch(await root(dir), { mode, scopes: [{ path: "a/b", kind: "tree" }], onInvalidate() {} }));
    await owner.ready;
    await fs.mkdir(path.join(dir, "a/b"), { recursive: true }); await owner.reconcile();
    expect(owner.health().directories).toBe(3);
    await fs.rm(path.join(dir, "a"), { recursive: true }); await owner.reconcile();
    expect(owner.health().directories).toBe(1);
  }, 30_000);
  test("bounds scanning and prunes excluded directories", async () => {
    await fs.mkdir(path.join(dir, "ignored/deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "kept"), "x");
    const owner = own(watch(await root(dir), { mode, scopes, maxDirectories: 1, exclude: entry => entry.path === "ignored", onInvalidate() {} }));
    await owner.ready; expect(owner.health().directories).toBe(1);
    const limited = own(watch(await root(dir), { mode, scopes, maxEntries: 1, onInvalidate() {} }));
    await expect(limited.ready).rejects.toMatchObject({ code: "too-large" });
    expect(limited.health().failure?.operation).toBe("scan");
  }, 30_000);
  test("rejects thenables and retains callback failure after successful close", async () => {
    const owner = own(watch(await root(dir), { mode, scopes, onInvalidate: async () => {} }));
    await expect(owner.ready).rejects.toMatchObject({ code: "helper-failed" });
    await owner.close();
    expect(owner.health()).toMatchObject({ state: "closed", failure: { operation: "callback", error: { code: "helper-failed" } } });
  }, 30_000);
});

it("validates literal scopes and required mode", async () => {
  const admitted = await root(dir);
  for (const name of ["../escape", "a/../b", "/absolute", "bad\0name"]) {
    expect(() => watch(admitted, { mode: "poll", scopes: [{ path: name, kind: "tree" }], onInvalidate() {} })).toThrow();
  }
  if (process.platform === "win32") for (const name of ["C:alias", "dir. ", "file:stream", "\\\\?\\C:\\root"]) {
    expect(() => watch(admitted, { mode: "poll", scopes: [{ path: name, kind: "tree" }], onInvalidate() {} })).toThrow();
  }
  expect(() => watch(admitted, { scopes, onInvalidate() {} } as never)).toThrow("mode");
  expect(() => watch(admitted, { mode: "poll", scopes: [{ path: "", kind: "tree", depth: 129 }], onInvalidate() {} })).toThrow();
  const owner = own(watch(admitted, { mode: "poll", scopes: [{ path: "./", kind: "tree" }], onInvalidate() {} }));
  await owner.ready;
});

it("fences setScopes immediately and rejects superseded admission", async () => {
  let emit!: Parameters<NonNullable<import("../src/test-hooks.js").FsSafeTestHooks["afterWatchBackendCreated"]>>[1];
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "auto", scopes, onInvalidate: value => { changes.push(value); } }));
  await owner.ready;
  const stale = emit;
  const superseded = owner.setScopes([{ path: "old", kind: "entry" }]);
  const current = owner.setScopes([{ path: "new", kind: "entry" }]);
  stale?.({ overflow: false, hints: [{ directory: "", name: "old", event: "rename" }] });
  await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
  changes.length = 0; await current;
  expect(changes).toEqual([{ reason: "reconcile", changes: undefined }]);
  stale?.({ overflow: true, hints: [] }); await owner.reconcile();
  expect(changes).toHaveLength(1);
});

it("joins held scans and makes close terminal and idempotent", async () => {
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => { entered(); await held; } });
  const owner = own(watch(await root(dir), { mode: "auto", scopes, onInvalidate() { throw new Error("late"); } }));
  await enteredPromise;
  const closing = owner.close(); expect(owner.close()).toBe(closing);
  let joined = false; void closing.then(() => { joined = true; });
  await Promise.resolve(); expect(joined).toBe(false);
  release(); await closing;
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  await expect(owner.setScopes(scopes)).rejects.toMatchObject({ name: "AbortError" });
  expect(owner.health()).toMatchObject({ state: "closed", directories: 0 });
});

it("selects auto, events and poll according to native-off policy", async () => {
  const previous = getFsSafeNativeConfig();
  const admitted = await root(dir);
  configureFsSafeNative({ mode: "off" });
  try {
    for (const mode of ["auto", "poll", "events"] as const) {
      const owner = own(watch(admitted, { mode, scopes, onInvalidate() {} }));
      if (mode === "events") {
        await expect(owner.ready).rejects.toMatchObject({ code: "helper-unavailable" });
        expect(owner.health().failure?.operation).toBe("watch");
      } else { await owner.ready; expect(owner.health().mode).toBe("poll"); }
      await owner.close();
    }
  } finally { configureFsSafeNative(previous); }
});

it.skipIf(!eventsAvailable)("shares one hub, delivers real events under one second, and joins the last close", async () => {
  const native = getNativeBinding()!;
  expect(native.watchThreadCount!()).toBe(0);
  const location = path.join(eventFixtures, "latency");
  const admitted = await root(location);
  const changes: WatchInvalidation[] = [];
  const first = own(watch(admitted, { mode: "events", scopes, onInvalidate() {} }));
  const peer = own(watch(admitted, { mode: "events", scopes, intervalMs: 60_000, onInvalidate: v => { changes.push(v); } }));
  await Promise.all([first.ready, peer.ready]);
  expect(native.watchThreadCount!()).toBe(1);
  await first.close(); expect(native.watchThreadCount!()).toBe(1); changes.length = 0;
  const started = performance.now();
  await fs.writeFile(path.join(location, "file"), "real-event");
  await expect.poll(() => changes.length, { timeout: 950, interval: 10 }).toBeGreaterThan(0);
  const latencyMs = performance.now() - started;
  expect(latencyMs).toBeLessThan(1000);
  expect(peer.health().mode).toBe("events");
  latencyProof = true;
  console.log(JSON.stringify({ proof: "watch-events-latency", fixture: "settled os.tmpdir Root", platform: process.platform, mode: peer.health().mode, latencyMs }));
  expect(changes.some(v => v.reason === "event" || v.reason === "overflow")).toBe(true);
  await peer.close(); expect(native.watchThreadCount!()).toBe(0);
});

it.skipIf(!eventsAvailable).each(["entry", "tree"] as const)("turns overflow and unadmitted names into whole-scope invalidations (%s)", async kind => {
  const native = getNativeBinding()!;
  const register = native.watchRegister!;
  // Exercise hint admission independently of OS coalescing and queue pressure.
  vi.spyOn(native, "watchRegister").mockImplementation((root, limit) => register(root, limit, () => {}));
  let emit!: (batch: import("../src/watch-native.js").NativeWatchBatch) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "events", scopes: [{ path: "", kind }], onInvalidate: v => { changes.push(v); } }));
  await owner.ready; changes.length = 0;
  await fs.writeFile(path.join(dir, "child"), "changed during overflow");
  emit({ overflow: true, hints: [] }); await owner.reconcile();
  expect(changes).toEqual([{ reason: "overflow", changes: undefined }]); changes.length = 0;
  emit({ overflow: false, hints: [{ directory: "", name: "unadmitted-private-name", event: "rename" }] });
  await owner.reconcile(); expect(changes).toEqual([{ reason: "overflow", changes: undefined }]);
});

it("reconciles periodically without backend hints", async () => {
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "poll", intervalMs: 20, scopes, onInvalidate: v => { changes.push(v); } }));
  await owner.ready; changes.length = 0;
  await fs.writeFile(path.join(dir, "timer-edit"), "x");
  await expect.poll(() => changes.some(v => v.reason === "reconcile" && v.changes?.some(c => c.path === "timer-edit"))).toBe(true);
});

it("honors unavailable-helper policy including native require", async () => {
  const { __setNativeLoaderForTest, __resetNativeLoaderForTest } = await import("../src/native.js");
  const previous = getFsSafeNativeConfig();
  const admitted = await root(dir);
  __setNativeLoaderForTest(() => { throw new Error("fixture missing binding"); });
  try {
    configureFsSafeNative({ mode: "auto" });
    const automatic = own(watch(admitted, { mode: "auto", scopes, onInvalidate() {} }));
    await automatic.ready; expect(automatic.health().mode).toBe("poll"); await automatic.close();
    configureFsSafeNative({ mode: "require" });
    const required = own(watch(admitted, { mode: "auto", scopes, onInvalidate() {} }));
    await expect(required.ready).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(required.health().failure?.operation).toBe("watch"); await required.close();
  } finally { __resetNativeLoaderForTest(); configureFsSafeNative(previous); }
});

it.skipIf(!eventsAvailable)("coalesces a real event burst while JavaScript is blocked", async () => {
  const { writeFileSync } = await import("node:fs");
  const changes: WatchInvalidation[] = [];
  const location = path.join(eventFixtures, "burst");
  const owner = own(watch(await root(location), { mode: "events", scopes, maxPendingPaths: 2, intervalMs: 60_000, onInvalidate: v => { changes.push(v); } }));
  await owner.ready; changes.length = 0;
  for (let i = 0; i < 40; i++) writeFileSync(path.join(location, "burst-" + i), "x");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  await expect.poll(() => changes.some(v => v.reason === "overflow" && v.changes === undefined), { timeout: 5000 }).toBe(true);
  expect(changes.every(v => !v.changes || v.changes.length <= 2)).toBe(true);
  await owner.close(); expect(getNativeBinding()!.watchThreadCount!()).toBe(0);
});
