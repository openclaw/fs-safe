import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { NativeWatchBackend, watchBinding } from "../src/watch-native.js";

const binding = watchBinding("auto");
if (process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !binding) {
  throw new Error("native watch lifecycle proof requires the freshly built addon");
}
const scopes = [{ path: "", kind: "tree" as const }];
let directory: string;
let owners: Set<WatchSubscription>;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-lifecycle-")));
  owners = new Set();
});
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  const closed = await Promise.allSettled([...owners].map(owner => owner.close()));
  const failures = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  try { await fs.rm(directory, { recursive: true, force: true }); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "watch fixture cleanup failed");
});
const own = (owner: WatchSubscription) => { owners.add(owner); return owner; };

it("keeps the scanned directory count visible when another pass is queued", async () => {
  const child = path.join(directory, "child");
  await fs.mkdir(child);
  const owner = own(watch(await root(directory), { mode: "poll", scopes, intervalMs: 60_000, onInvalidate() {} }));
  await owner.ready;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(owner.health().directories).toBe(2);
  await fs.rm(child, { recursive: true });
  let queued: Promise<void> | undefined;
  __setFsSafeTestHooksForTest({
    afterWatchRegistration: () => { queued ??= owner.reconcile(); },
  });
  try {
    await owner.reconcile();
    expect(owner.health().directories).toBe(1);
  } finally { __setFsSafeTestHooksForTest(); await queued; }
});

it.skipIf(!binding)("automatically scans once after native stream handover without another request or hint", async () => {
  const nativeRegister = binding!.watchRegister!;
  vi.spyOn(binding!, "watchRegister").mockImplementation((root, limit, _callback, persistent) => nativeRegister(root, limit, () => {}, persistent));
  const owner = own(watch(await root(directory), { mode: "events", scopes, intervalMs: 60_000, onInvalidate() {} }));
  await owner.ready;
  await new Promise<void>(resolve => setImmediate(resolve));
  const configure = vi.spyOn(NativeWatchBackend.prototype, "configure")
    .mockReturnValue(false).mockReturnValueOnce(true);
  // Handover rescans within one reconciliation, before publishing readiness.
  let passes = 0;
  __setFsSafeTestHooksForTest({ afterWatchRegistration: () => { passes++; } });
  await owner.reconcile();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(passes).toBe(2);
  expect(configure).toHaveBeenCalledTimes(2);
});

it("carries running and queued reconciliations through repeated scope replacement", async () => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const invalidations: WatchInvalidation[] = [];
  const owner = own(watch(await root(directory), { mode: "poll", scopes, onInvalidate: value => { invalidations.push(value); } }));
  await owner.ready;
  invalidations.length = 0;
  let passes = 0;
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => {
    if (++passes === 1) { entered(); await held; }
  } });
  const running = owner.reconcile();
  await enteredPromise;
  try {
    const queued = owner.reconcile();
    const superseded = owner.setScopes([{ path: "old", kind: "entry" }]);
    const replacement = owner.setScopes([{ path: "new", kind: "entry" }]);
    expect(owner.reconcile()).toBe(queued);
    await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
    release();
    await Promise.all([running, queued, replacement]);
    expect(passes).toBe(2);
    expect(invalidations).toEqual([{ reason: "reconcile", changes: undefined }]);
  } finally { release(); }
});

it("replaces a generation from its baseline callback without publishing it as ready", async () => {
  let replacement: Promise<void> | undefined;
  const invalidations: WatchInvalidation[] = [];
  const owner = own(watch(await root(directory), {
    mode: "poll", scopes,
    onInvalidate(value) {
      invalidations.push(value);
      replacement ??= owner.setScopes([{ path: "next", kind: "entry" }]);
    },
  }));
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  await replacement;
  expect(owner.health()).toMatchObject({ state: "ready", directories: 1 });
  expect(invalidations).toEqual([
    { reason: "reconcile", changes: undefined },
    { reason: "reconcile", changes: undefined },
  ]);
});

it("joins close from the ready health callback and rejects startup", async () => {
  let closing: Promise<void> | undefined;
  const owner = own(watch(await root(directory), {
    mode: "poll", scopes, onInvalidate() {},
    onHealth(value) { if (value.state === "ready") closing = owner.close(); },
  }));
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  expect(owner.close()).toBe(closing);
  await closing;
  expect(owner.health()).toMatchObject({ state: "closed", directories: 0 });
  await expect(owner.reconcile()).rejects.toMatchObject({ name: "AbortError" });
});

describe.skipIf(!binding).each(["idle", "active", "scheduled", "replacement"] as const)("%s scope replacement after failed retirement", phase => {
  it.each([
    { label: "Error", retirement: new Error("retirement fixture") },
    { label: "null", retirement: null },
    { label: "undefined", retirement: undefined },
  ])("preserves the $label rejection and settles all waiters", async ({ retirement }) => {
    const nativeRegister = binding!.watchRegister!;
    // Keep native registration/join, but let this matrix control every reconciliation.
    const register = vi.spyOn(binding!, "watchRegister").mockImplementation((root, limit, _callback, persistent) => nativeRegister(root, limit, () => {}, persistent));
    const owner = own(watch(await root(directory), { mode: "events", scopes, intervalMs: 60_000, onInvalidate() {} }));
    await owner.ready;
    // Let the startup pump finish before exercising the idle retirement path.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    let release = () => {};
    let running: Promise<void> | undefined;
    let superseded: Promise<void> | undefined;
    if (phase === "active" || phase === "replacement") {
      let entered!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => { entered(); await held; } });
      if (phase === "active") running = owner.reconcile();
      else superseded = owner.setScopes([{ path: "first", kind: "entry" }]);
      await enteredPromise;
    }
    try {
      const unregister = binding!.watchUnregister!;
      const stop = vi.spyOn(binding!, "watchUnregister").mockImplementation(id => {
        unregister(id);
        throw retirement;
      });
      register.mockClear();
      if (phase === "scheduled") running = owner.reconcile();
      const replacement = owner.setScopes([{ path: "next", kind: "entry" }]);
      const queued = owner.reconcile();
      release();
      const replacementError = await replacement.then(() => { throw new Error("replacement unexpectedly resolved"); }, error => error);
      const rejected = await queued.then(() => { throw new Error("reconciliation unexpectedly resolved"); }, error => error);
      if (retirement === undefined) {
        expect(rejected).toMatchObject({
          code: "helper-failed", message: "watch operation failed without an error value",
          details: { operation: phase === "idle" ? "close" : "scan" },
        });
        expect(replacementError).toBe(phase === "scheduled" ? undefined : rejected);
      } else {
        expect(replacementError).toBe(retirement);
        expect(rejected).toBe(retirement);
      }
      if (running) await expect(running).rejects.toBe(rejected);
      if (superseded) await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
      await expect(owner.reconcile()).rejects.toBe(rejected);
      expect(register).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(owner.health()).toMatchObject({ state: "unavailable", directories: 0, failure: { operation: "close" } });
      const closing = owner.close();
      expect(owner.close()).toBe(closing);
      const closeError = await closing.then(() => { throw new Error("close unexpectedly resolved"); }, error => error);
      if (retirement === undefined) {
        expect(closeError).toMatchObject({ name: "SuppressedError", error: undefined });
        expect(closeError.suppressed).toBe(rejected);
      } else expect(closeError).toBe(retirement);
      expect(owner.health().state).toBe("closed");
      owners.delete(owner);
    } finally { release(); }
  });
});
