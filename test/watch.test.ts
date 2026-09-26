import fs from "node:fs/promises";
import fsSync from "node:fs";
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
    expect(executedEventCases).toBe(10);
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
  await fs.mkdir(path.join(eventFixtures, "scopes/tree/child/deep"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(eventFixtures, "symlinks/target"), { recursive: true });
  await fs.symlink(path.join(eventFixtures, "symlinks/target"), path.join(eventFixtures, "symlinks/link"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(eventFixtures, "latency/file"), "before");
  // FSEvents can coalesce creation and a later edit under a pre-subscription event ID.
  if (process.platform === "darwin") await new Promise(resolve => setTimeout(resolve, 3000));
});
afterAll(async () => { await fs.rm(eventFixtures, { recursive: true, force: true }); });
let owners: WatchSubscription[];
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-"))); owners = []; if (process.platform === "darwin" && dir.includes("/claude-501/")) throw new Error("watch fixtures must use normal os.tmpdir()"); });
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  await Promise.all(owners.map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});
function own(owner: WatchSubscription) { owners.push(owner); return owner; }

describe.each(["events", "poll"] as const)("watch %s", mode => {
  const test = it.skipIf(mode === "events" && !eventsAvailable);
  beforeEach(() => { if (mode === "events") executedEventCases++; });
  test("observes entry vs tree, depth and directory metadata", async () => {
    const location = mode === "events" ? path.join(eventFixtures, "scopes") : dir;
    if (mode === "poll") await fs.mkdir(path.join(location, "tree/child/deep"), { recursive: true, mode: 0o700 });
    const changes: WatchInvalidation[] = [];
    const owner = own(watch(await root(location), { mode, scopes: [{ path: "tree/", kind: "entry" }], onInvalidate: value => { changes.push(value); } }));
    await owner.ready;
    expect(changes).toEqual([{ reason: "reconcile", changes: undefined }]);
    changes.length = 0;
    await fs.writeFile(path.join(location, "tree/child/file"), "x");
    await owner.reconcile();
    // Slow event catch-up may invalidate every scope, even for child-only activity.
    expect(changes.every(value => value.reason === "overflow" && value.changes === undefined)).toBe(true);
    await owner.setScopes([{ path: "tree", kind: "tree", depth: 1 }]);
    expect(changes.at(-1)).toEqual({ reason: "reconcile", changes: undefined });
    changes.length = 0;
    await fs.writeFile(path.join(location, "tree/top"), "x");
    await owner.reconcile();
    expect(changes.some(value => (value.reason === "overflow" && value.changes === undefined) || value.changes?.some(change => change.path === path.join("tree", "top")))).toBe(true);
    if (process.platform !== "win32") {
      await owner.setScopes([{ path: "", kind: "entry" }]); changes.length = 0;
      await fs.chmod(location, 0o750); await owner.reconcile();
      expect(changes.some(value => (value.reason === "overflow" && value.changes === undefined) || value.changes?.some(change => change.path === ""))).toBe(true);
    }
  }, 30_000);
  test("does not follow symlink entries and rejects symbolic parents", async () => {
    const location = mode === "events" ? path.join(eventFixtures, "symlinks") : dir;
    if (mode === "poll") {
      await fs.mkdir(path.join(location, "target"));
      await fs.symlink(path.join(location, "target"), path.join(location, "link"), process.platform === "win32" ? "junction" : "dir");
    }
    const changes: WatchInvalidation[] = [];
    const owner = own(watch(await root(location), { mode, scopes: [{ path: "link", kind: "tree" }], onInvalidate: v => { changes.push(v); } }));
    await owner.ready; changes.length = 0;
    await fs.writeFile(path.join(location, "target/file"), "private"); await owner.reconcile();
    expect(changes.every(value => value.reason === "overflow" && value.changes === undefined)).toBe(true);
    const invalid = own(watch(await root(location), { mode, scopes: [{ path: "link/file", kind: "entry" }], onInvalidate() {} }));
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
    expect(limited.health()).toMatchObject({ state: "unavailable", failure: { operation: "scan", code: "too-large" } });
    const directories = own(watch(await root(dir), { mode, scopes, maxDirectories: 1, onInvalidate() {} }));
    await expect(directories.ready).rejects.toMatchObject({ code: "too-large" });
    expect(directories.health()).toMatchObject({ state: "unavailable", failure: { operation: "scan", code: "too-large" } });
  }, 30_000);
  test("stays available under sustained writes and keeps an invalidation-only cache current", async () => {
    await Promise.all(Array.from({ length: 1024 }, (_, n) => fs.writeFile(path.join(dir, `file-${n}`), "initial")));
    const capability = await root(dir);
    const cache = new Map<string, string>();
    const failures: unknown[] = [];
    const states: string[] = [];
    let refresh = Promise.resolve();
    let refreshPending = false, refreshing = false;
    const owner = own(watch(capability, { mode, scopes, intervalMs: mode === "poll" ? 20 : 60_000,
      onHealth: value => { states.push(value.state); },
      onInvalidate: () => {
        refreshPending = true;
        if (refreshing) return;
        refreshing = true;
        refresh = Promise.resolve().then(async () => {
          do {
            refreshPending = false;
            const next = new Map<string, string>();
            const names = await capability.list("");
            for (let i = 0; i < names.length; i += 16) {
              await Promise.all(names.slice(i, i + 16).map(async name => { next.set(name, await capability.readText("./" + name)); }));
            }
            cache.clear(); for (const [name, value] of next) cache.set(name, value);
          } while (refreshPending);
        }).catch(error => { failures.push(error); }).finally(() => { refreshing = false; });
      },
    }));
    await owner.ready; await refresh;
    const end = performance.now() + 1500;
    let writes = 0;
    while (performance.now() < end) {
      await fs.writeFile(path.join(dir, "file-0"), `edit-${++writes}`);
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    await owner.reconcile(); await refresh;
    expect(states).not.toContain("unavailable");
    expect(writes).toBeGreaterThan(20);
    const truth = new Map<string, string>();
    for (const name of await fs.readdir(dir)) truth.set(name, await fs.readFile(path.join(dir, name), "utf8"));
    expect(cache).toEqual(truth);
    await fs.writeFile(path.join(dir, "file-0"), "isolated-final-edit");
    await expect.poll(() => cache.get("file-0"), { timeout: 5000 }).toBe("isolated-final-edit");
    await owner.close(); await refresh;
    expect(failures).toEqual([]);
  }, 30_000);
  test("resolves readiness while the baseline is changing", async () => {
    await fs.writeFile(path.join(dir, "changing"), "initial");
    let writes = 0;
    __setFsSafeTestHooksForTest({ afterWatchRegistration: async () => {
      await fs.writeFile(path.join(dir, "changing"), String(++writes));
    } });
    const owner = own(watch(await root(dir), { mode, scopes, onInvalidate() {} }));
    await owner.ready;
    expect(["ready", "reconciling"]).toContain(owner.health().state);
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThan(4);
  });
  test("re-registers a directory replaced between registration and listing", async () => {
    const child = path.join(dir, "child"); await fs.mkdir(child);
    let registrations = 0, baselineRegistrations = 0, backends = 0;
    __setFsSafeTestHooksForTest({
      afterWatchBackendCreated: () => { backends++; },
      afterWatchRegistration: async name => {
        if (name !== child) return;
        if (++registrations === 1) {
          await fs.rename(child, path.join(dir, "retired"));
          await fs.mkdir(child); await fs.writeFile(path.join(child, "new"), "new");
        }
      },
    });
    const owner = own(watch(await root(dir), { mode, scopes: [{ path: "child", kind: "tree" }], onInvalidate: () => { baselineRegistrations ||= registrations; } }));
    await owner.ready;
    expect(["ready", "reconciling"]).toContain(owner.health().state);
    expect(baselineRegistrations).toBe(2);
    expect(backends).toBe(mode === "events" ? 1 : 0);
  });
  test("treats a directory changing kind mid-pass as structural churn", async () => {
    const child = path.join(dir, "child"); await fs.mkdir(child);
    const changes: WatchInvalidation[] = [];
    let replace = false;
    const owner = own(watch(await root(dir), { mode, scopes, onInvalidate: value => { changes.push(value); },
      exclude: entry => {
        if (replace && entry.path === "child" && entry.kind === "directory") {
          replace = false; fsSync.rmdirSync(child); fsSync.writeFileSync(child, "now a file");
        }
        return false;
      },
    }));
    await owner.ready; changes.length = 0; replace = true;
    await owner.reconcile();
    expect(owner.health().failure).toBeUndefined();
    expect(changes.some(value => !value.changes || value.changes.some(change => change.path === "child" && change.type === "structural"))).toBe(true);
  });
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

it.skipIf(!eventsAvailable)("turns overflow and unadmitted names into whole-scope invalidations", async () => {
  let emit!: (batch: import("../src/watch-native.js").NativeWatchBatch) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "events", scopes, onInvalidate: v => { changes.push(v); } }));
  await owner.ready; changes.length = 0;
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

it("waits for a pass started after reconcile, coalescing only pending calls", async () => {
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = own(watch(await root(dir), { mode: "poll", scopes, onInvalidate() {} }));
  await owner.ready;
  let passes = 0;
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => {
    if (++passes === 1) { entered(); await held; }
  } });
  const first = owner.reconcile(); await enteredPromise;
  const second = owner.reconcile(), peer = owner.reconcile();
  release();
  expect(peer).toBe(second); expect(second).not.toBe(first);
  await Promise.all([first, second]);
  expect(passes).toBe(2);
});

it("bounds per-directory replacement retries without failing the subscription", async () => {
  const child = path.join(dir, "child"); await fs.mkdir(child);
  let registrations = 0;
  __setFsSafeTestHooksForTest({ afterWatchRegistration: async name => {
    if (name !== child) return;
    await fs.rename(child, path.join(dir, `old-${++registrations}`)); await fs.mkdir(child);
  } });
  const owner = own(watch(await root(dir), { mode: "poll", scopes: [{ path: "child", kind: "tree" }], onInvalidate() {} }));
  await owner.ready;
  expect(registrations).toBe(3);
  expect(owner.health().state).toBe("ready");
  __setFsSafeTestHooksForTest();
  await owner.reconcile();
  expect(owner.health().directories).toBe(2);
});

it.skipIf(!eventsAvailable)("coalesces hints during a slow pass and reports undetailed overflow", async () => {
  let emit!: (batch: import("../src/watch-native.js").NativeWatchBatch) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const changes: WatchInvalidation[] = [];
  const owner = own(watch(await root(dir), { mode: "events", scopes, onInvalidate: value => { changes.push(value); } }));
  await owner.ready; changes.length = 0;
  let passes = 0;
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => {
    if (++passes === 1) {
      for (let i = 0; i < 100; i++) emit({ hints: [], overflow: true });
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  } });
  await owner.reconcile();
  await expect.poll(() => owner.health().state).toBe("ready");
  expect(passes).toBe(2);
  expect(changes.some(value => value.reason === "overflow" && value.changes === undefined)).toBe(true);
});

it("keeps reconcile requests alive across a fenced scope replacement", async () => {
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = own(watch(await root(dir), { mode: "poll", scopes, onInvalidate() {} }));
  await owner.ready;
  let passes = 0;
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => {
    if (++passes === 1) { entered(); await held; }
  } });
  const reconciliation = owner.reconcile(); await enteredPromise;
  const replacement = owner.setScopes([{ path: "new", kind: "entry" }]);
  release();
  await expect(reconciliation).resolves.toBeUndefined();
  await replacement;
  expect(passes).toBe(2);
});

it.skipIf(!eventsAvailable)("preserves isolated event detail after the normal coalescing delay", async () => {
  await fs.writeFile(path.join(dir, "file"), "data");
  let emit!: (batch: import("../src/watch-native.js").NativeWatchBatch) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  let notified!: (value: WatchInvalidation) => void;
  const notification = new Promise<WatchInvalidation>(resolve => { notified = resolve; });
  let ready = false;
  const owner = own(watch(await root(dir), { mode: "events", scopes, onInvalidate: value => { if (ready) notified(value); } }));
  await owner.ready; ready = true;
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    emit({ hints: [{ directory: "", name: "file", event: "change" }], overflow: false });
    now = 26; // Intentional debounce time, with no slow scan or pending work.
    expect(await notification).toEqual({ reason: "event", changes: [{ path: "file", type: "content" }] });
  } finally { clock.mockRestore(); }
});

it.skipIf(!eventsAvailable)("retries transient descendant registration errors but fails lost Root access", async () => {
  await fs.mkdir(path.join(dir, "child"));
  const binding = getNativeBinding()!;
  const add = binding.watchAdd!.bind(binding);
  for (const code of ["EACCES", "EPERM", "EBUSY"]) {
    let attempts = 0;
    const mocked = vi.spyOn(binding, "watchAdd").mockImplementation((id, directory) => {
      if (directory.relative === "child" && ++attempts === 1) throw Object.assign(new Error("transient access"), { code });
      add(id, directory);
    });
    try {
      const owner = own(watch(await root(dir), { mode: "events", scopes, onInvalidate() {} }));
      await owner.ready;
      expect(attempts).toBe(2);
      expect(owner.health().failure).toBeUndefined();
      await owner.close();
    } finally { mocked.mockRestore(); }
  }
  for (const code of ["EACCES", "EBUSY"]) {
    let attempts = 0;
    const mocked = vi.spyOn(binding, "watchAdd").mockImplementation(() => { attempts++; throw Object.assign(new Error("Root access"), { code }); });
    try {
      const owner = own(watch(await root(dir), { mode: "events", scopes: [{ path: "child", kind: "tree" }], onInvalidate() {} }));
      await expect(owner.ready).rejects.toMatchObject({ details: { code: code === "EBUSY" ? "registration-failed" : code } });
      expect(owner.health().state).toBe("unavailable");
      expect(attempts).toBe(code === "EBUSY" ? 3 : 1);
    } finally { mocked.mockRestore(); }
  }
});
