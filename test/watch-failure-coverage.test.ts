import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, getFsSafeNativeConfig } from "../src/config.js";
import type { NativeBinding } from "../src/native.js";
import * as nativeWatch from "../src/watch-native.js";
import { __setFsSafeTestHooksForTest as hooks } from "../src/test-hooks.js";
import { watch, type WatchOptions, type WatchSubscription, type WatchInvalidation } from "../src/watch.js";

const scopes = [{ path: "", kind: "tree" as const }];
let dir: string;
let capability: Awaited<ReturnType<typeof root>>;
let owners: WatchSubscription[];
const config = getFsSafeNativeConfig();
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-failure-")));
  capability = await root(dir);
  owners = [];
});
afterEach(async () => {
  hooks();
  await Promise.allSettled(owners.map(owner => owner.close()));
  vi.restoreAllMocks();
  configureFsSafeNative(config);
  await fs.rm(dir, { recursive: true, force: true });
});
function make(options: Partial<WatchOptions> = {}) {
  const owner = watch(capability, { mode: "poll", scopes, intervalMs: 60_000, onInvalidate() {}, ...options });
  owners.push(owner); return owner;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function backend() {
  const binding = { watchRegister: vi.fn(() => 1), watchAdd: vi.fn(), watchConfigure: vi.fn(), watchUnregister: vi.fn() };
  vi.spyOn(nativeWatch, "watchBinding").mockReturnValue(binding as unknown as NativeBinding);
  return binding;
}

it.each([0, -1, 1.1, NaN, Infinity, 2_147_483_648, 19])("rejects interval %s", value => {
  expect(() => make({ intervalMs: value })).toThrow(RangeError);
});
it.each(["maxDirectories", "maxEntries", "maxPendingPaths"] as const)("rejects an invalid %s budget", name => {
  expect(() => make({ [name]: 0 })).toThrow(RangeError);
});
it("requires an invalidation callback", () => {
  expect(() => make({ onInvalidate: undefined })).toThrow("onInvalidate");
});

it.each([true, false])("aborts admission or a ready subscription (pre-aborted: %s)", async pre => {
  const controller = new AbortController();
  if (pre) controller.abort();
  const invalidations = vi.fn();
  const owner = make({ signal: controller.signal, onInvalidate: invalidations });
  if (pre) await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  else { await owner.ready; controller.abort(); }
  await owner.close();
  expect(owner.health()).toMatchObject({ state: "closed", directories: 0 });
  await expect(owner.reconcile()).rejects.toMatchObject({ name: "AbortError" });
  expect(invalidations).toHaveBeenCalledTimes(pre ? 0 : 1);
});

it("joins an aborted in-flight scan and rejects both reconcile waiters", async () => {
  const controller = new AbortController();
  const owner = make({ signal: controller.signal }); await owner.ready;
  const entered = gate(), release = gate();
  hooks({ beforeWatchRegistration: async () => { entered.resolve(); await release.promise; } });
  const first = owner.reconcile(); await entered.promise;
  const pending = owner.reconcile(); controller.abort();
  const outcomes = Promise.allSettled([first, pending]);
  release.resolve(); await owner.close();
  expect(await outcomes).toEqual(Array.from({ length: 2 }, () => ({ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) })));
});

it.each([undefined, null, new Error("scan failure")])("retains a scan failure and rejects subsequent work (%s)", async failure => {
  hooks({ beforeWatchRegistration: () => { throw failure; } });
  const owner = make();
  await expect(owner.ready).rejects.toBe(failure);
  expect(owner.health()).toMatchObject({ state: "unavailable", failure: { operation: "scan" } });
  const retained = owner.health().failure!.error;
  if (failure === undefined) expect(retained).toMatchObject({ code: "helper-failed" });
  else expect(retained).toBe(failure);
  await expect(owner.reconcile()).rejects.toBe(retained);
  await expect(owner.setScopes(scopes)).rejects.toBe(retained);
  await owner.close(); expect(owner.health().failure!.error).toBe(retained);
});

it.each(["throw", "thenable"])("fails closed when health callbacks %s", async kind => {
  const owner = make({ onHealth: () => {
    if (kind === "throw") throw new Error("health callback");
    return Promise.resolve();
  } });
  await expect(owner.ready).rejects.toMatchObject({ code: "helper-failed", details: { operation: "callback" } });
  expect(owner.health()).toMatchObject({ state: "unavailable", failure: { operation: "callback" } });
  await owner.close(); expect(owner.health().state).toBe("closed");
});

it("closes synchronously from a health callback without publishing", async () => {
  const invalidations = vi.fn();
  const owner = make({ onInvalidate: invalidations, onHealth: () => { void owner.close(); } });
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  await owner.close(); expect(invalidations).not.toHaveBeenCalled();
});

it("fences a scope accessor that closes during validation", async () => {
  const owner = make(); await owner.ready;
  await expect(owner.setScopes([{ get path() { void owner.close(); return "new"; }, kind: "entry" }])).rejects.toMatchObject({ name: "AbortError" });
  await owner.close(); expect(owner.health().state).toBe("closed");
});

it("fences a scope accessor that replaces the generation during validation", async () => {
  const owner = make(); await owner.ready;
  let winner!: Promise<void>;
  await expect(owner.setScopes([{ get path() { winner = owner.setScopes([]); return "loser"; }, kind: "entry" }])).rejects.toMatchObject({ name: "AbortError" });
  await winner; expect(owner.health()).toMatchObject({ state: "ready", directories: 0 });
});

it("carries running and pending reconcile waiters into a replacement baseline", async () => {
  const owner = make(); await owner.ready;
  const entered = gate(), release = gate(); let passes = 0;
  hooks({ beforeWatchRegistration: async () => { if (++passes === 1) { entered.resolve(); await release.promise; } } });
  const first = owner.reconcile(); await entered.promise;
  const pending = owner.reconcile();
  const replacement = owner.setScopes([{ path: "new", kind: "entry" }]);
  release.resolve();
  await Promise.all([first, pending, replacement]);
  expect(passes).toBe(2); expect(owner.health().state).toBe("ready");
});

it.each(["register", "add"])("falls back during initial %s only in auto mode", async stage => {
  const binding = backend();
  binding[stage === "register" ? "watchRegister" : "watchAdd"].mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  const invalidations: WatchInvalidation[] = [];
  const owner = make({ mode: "auto", onInvalidate: value => { invalidations.push(value); } });
  await owner.ready;
  expect(owner.health()).toMatchObject({ mode: "poll", state: "ready" });
  expect(binding.watchUnregister).toHaveBeenCalledTimes(stage === "add" ? 1 : 0);
  await fs.writeFile(path.join(dir, "edit"), "value"); await owner.reconcile();
  expect(invalidations.at(-1)?.changes).toContainEqual({ path: "edit", type: "structural" });
});

it.each(["events", "require", "other-code"])("refuses fallback for %s", async policy => {
  const binding = backend();
  if (policy === "require") configureFsSafeNative({ mode: "require" });
  binding.watchRegister.mockImplementation(() => { throw Object.assign(new Error("register"), { code: policy === "other-code" ? "EACCES" : "ENOTSUP" }); });
  const owner = make({ mode: policy === "events" ? "events" : "auto" });
  await expect(owner.ready).rejects.toMatchObject({ code: policy === "other-code" ? "helper-failed" : "helper-unavailable" });
  expect(owner.health()).toMatchObject({ state: "unavailable", mode: "events" });
});

it("does not fall back after an event baseline is established", async () => {
  const binding = backend(); const owner = make({ mode: "auto" }); await owner.ready;
  await fs.mkdir(path.join(dir, "new"));
  binding.watchAdd.mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  await expect(owner.reconcile()).rejects.toMatchObject({ code: "helper-unavailable" });
  expect(owner.health()).toMatchObject({ state: "unavailable", mode: "events" });
});

it.each(["close", "scopes", "failure"])("retains backend retirement failure during %s", async action => {
  const binding = backend(); const owner = make({ mode: "events" }); await owner.ready;
  const retirement = new Error("unregister"); binding.watchUnregister.mockImplementation(() => { throw retirement; });
  if (action === "scopes") await expect(owner.setScopes([])).rejects.toBe(retirement);
  if (action === "failure") {
    hooks({ beforeWatchRegistration: () => { throw new Error("scan"); } });
    await expect(owner.reconcile()).rejects.toThrow("scan");
  }
  if (action === "failure") await expect(owner.close()).rejects.toMatchObject({ error: retirement, suppressed: expect.objectContaining({ message: "scan" }) });
  else await expect(owner.close()).rejects.toBe(retirement);
  expect(owner.health()).toMatchObject({ state: "closed", failure: { operation: "close" } });
  expect(binding.watchUnregister).toHaveBeenCalledTimes(1);
});

it("reports a backend error once and ignores late hints", async () => {
  backend(); let emit!: (batch: nativeWatch.NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const invalidations = vi.fn(); const owner = make({ mode: "events", onInvalidate: invalidations }); await owner.ready;
  emit({ hints: [], overflow: false, error: "EACCES" });
  await expect(owner.reconcile()).rejects.toMatchObject({ details: { code: "EACCES" } });
  emit({ hints: [], overflow: true });
  await owner.close();
  expect(owner.health().failure).toMatchObject({ operation: "watch", code: "EACCES" });
  expect(invalidations).toHaveBeenCalledTimes(1);
});

it("rejects asynchronous backend-created hooks and retires the backend", async () => {
  const binding = backend(); hooks({ afterWatchBackendCreated: async () => {} });
  const owner = make({ mode: "auto" });
  await expect(owner.ready).rejects.toThrow();
  await owner.close(); expect(binding.watchUnregister).toHaveBeenCalledTimes(1);
});

it.each([false, true])("applies persistent=%s to interval and hint timers", async persistent => {
  const binding = backend(); let emit!: (batch: nativeWatch.NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const invalidations = vi.fn();
  const owner = make({ mode: "events", persistent, onInvalidate: invalidations });
  try {
    await owner.ready; await owner.reconcile(); await vi.advanceTimersByTimeAsync(0);
    expect(binding.watchRegister).toHaveBeenCalledWith(dir, 256, expect.any(Function), persistent);
    expect(timers.mock.results.at(-1)!.value.hasRef()).toBe(persistent);
    emit({ hints: [], overflow: true });
    expect(timers.mock.calls.at(-1)![1]).toBe(25);
    expect(timers.mock.results.at(-1)!.value.hasRef()).toBe(persistent);
    await vi.advanceTimersByTimeAsync(25); await owner.reconcile();
    expect(invalidations).toHaveBeenLastCalledWith({ reason: "overflow", changes: undefined });
    await owner.close(); expect(vi.getTimerCount()).toBe(0);
  } finally { await owner.close(); vi.useRealTimers(); }
});

it("uses the poll interval default after automatic backend fallback", async () => {
  const binding = backend();
  binding.watchRegister.mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const owner = make({ mode: "auto", intervalMs: undefined });
  try {
    await owner.ready; await vi.advanceTimersByTimeAsync(0);
    expect(owner.health().mode).toBe("poll");
    expect(timers.mock.calls.at(-1)![1]).toBe(1000);
  } finally { await owner.close(); vi.useRealTimers(); }
});

it("keeps rename hints when later change hints arrive and bounds distinct pending names", async () => {
  backend(); let emit!: (batch: nativeWatch.NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  await fs.writeFile(path.join(dir, "file"), "value");
  const changes: WatchInvalidation[] = [];
  const owner = make({ mode: "events", maxPendingPaths: 1, onInvalidate: value => { changes.push(value); } });
  await owner.ready; changes.length = 0;
  // Hold elapsed time fixed so this specifically checks hint detail, not slow-scan overflow.
  vi.spyOn(performance, "now").mockReturnValue(0);
  emit({ hints: [{ directory: "", name: "file", event: "rename" }], overflow: false });
  emit({ hints: [{ directory: "", name: "file", event: "change" }], overflow: false });
  await owner.reconcile();
  expect(changes).toEqual([{ reason: "event", changes: [{ path: "file", type: "structural" }] }]);
  emit({ hints: ["file", "second"].map(name => ({ directory: "", name, event: "change" })), overflow: false });
  await owner.reconcile();
  expect(changes.at(-1)).toEqual({ reason: "overflow", changes: undefined });
});

it("coalesces backend overflow during a slow pass into one pending overflow", async () => {
  backend(); let emit!: (batch: nativeWatch.NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const changes: WatchInvalidation[] = [];
  let passes = 0, now = 0;
  const secondPass = gate();
  const owner = make({ mode: "events", onInvalidate: value => { changes.push(value); },
    onHealth: value => { if (value.state === "ready" && passes === 2) secondPass.resolve(); },
  });
  await owner.ready; changes.length = 0;
  // Isolate coalescing from OS hints and advance only the scan-duration clock.
  vi.spyOn(performance, "now").mockImplementation(() => now);
  hooks({ beforeWatchRegistration: () => {
    if (++passes === 1) {
      for (let index = 0; index < 100; index++) emit({ hints: [], overflow: true });
      now = 40;
    }
  } });
  await owner.reconcile(); await secondPass.promise;
  expect(passes).toBe(2);
  expect(changes).toEqual([
    { reason: "overflow", changes: undefined },
  ]);
});

it("drops guarded unselected sibling hints and preserves selected detail", async () => {
  backend(); let emit!: (batch: nativeWatch.NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  await fs.writeFile(path.join(dir, "config.json"), "value");
  const invalidations: WatchInvalidation[] = [];
  const owner = make({ mode: "events", maxPendingPaths: 1025, scopes: [{ path: "config.json", kind: "entry" }],
    onInvalidate: value => { invalidations.push(value); },
  });
  await owner.ready; await owner.reconcile(); invalidations.length = 0;
  const noise = { hints: Array.from({ length: 1024 }, (_, n) => ({ directory: "", name: `sibling-${n}`, event: "rename" as const })), overflow: false };
  emit(noise); await owner.reconcile();
  expect(invalidations).toEqual([]);
  emit(noise);
  emit({ hints: [{ directory: "", name: "config.json", event: "change" }], overflow: false });
  await owner.reconcile();
  expect(invalidations).toEqual([{ reason: "event", changes: [{ path: "config.json", type: "content" }] }]);
});
