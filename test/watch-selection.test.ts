import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";
import type { NativeWatchBatch } from "../src/watch-native.js";
import { getNativeBinding } from "../src/native.js";
import { __setFsSafeTestHooksForTest as hooks } from "../src/test-hooks.js";
import { watchDiagnostics } from "./helpers/watch-diagnostics.js";

const events = !!watchBinding("auto");
if (process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !events) throw new Error("selection proof requires the source-built native binding");
let directory: string;
let owner: WatchSubscription | undefined;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-selection-")));
});
afterEach(async () => {
  hooks(); await owner?.close(); owner = undefined; vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function settle() {
  // Drain native delivery, including FSEvents batching, before the explicit checkpoint.
  await delay(150); await owner!.reconcile();
}
function detailed(values: WatchInvalidation[], name: string) {
  expect(values.length).toBeGreaterThan(0);
  expect(values.every(value => value.reason !== "overflow" && value.changes?.every(change => change.path === name))).toBe(true);
}

describe.each(["events", "poll"] as const)("selected observation (%s)", mode => {
  const test = it.skipIf(mode === "events" && !events);
  test.each(["excluded transient", "atomic replacement"])("keeps detail without overflow for an %s file between passes", async operation => {
    const selected = path.join("src", "selected.ts");
    const temporary = path.join("src", "selected.ts.tmp");
    await fs.mkdir(path.join(directory, "src"));
    await fs.writeFile(path.join(directory, selected), "before");
    const diagnostics = watchDiagnostics(selected);
    const values: WatchInvalidation[] = [];
    owner = watch(await root(directory), {
      mode, scopes: [{ path: "src", kind: "tree" }], intervalMs: 60_000,
      exclude: entry => operation === "excluded transient" && entry.path.endsWith(".tmp"),
      onInvalidate: value => { diagnostics.invalidation(value); values.push(value); },
    });
    await owner.ready;
    await fs.writeFile(path.join(directory, selected), "fixture sentinel edit");
    if (mode === "events") await expect.poll(() => values.some(value => value.reason === "event" && value.changes?.some(change => change.path === selected)), { timeout: 5000 }).toBe(true);
    await diagnostics.quiet(owner); values.length = 0;
    expect(owner.health().mode).toBe(mode);
    for (let round = 0; round < 3; round++) {
      // Synchronous mutations leave no JS scan between creation and removal/rename.
      fsSync.writeFileSync(path.join(directory, temporary), `replacement ${round}`);
      if (operation === "excluded transient") fsSync.unlinkSync(path.join(directory, temporary));
      else fsSync.renameSync(path.join(directory, temporary), path.join(directory, selected));
      await owner.reconcile();
      if (operation === "atomic replacement" && mode === "events") await expect.poll(() => values.some(value => value.reason === "event" && value.changes?.some(change => change.path === selected)), { timeout: 5000 }).toBe(true);
      await diagnostics.quiet(owner);
      expect(values.every(value => value.reason !== "overflow")).toBe(true);
      expect(values.flatMap(value => value.changes ?? []).some(change => change.path === temporary)).toBe(false);
      if (operation === "atomic replacement") expect(values.some(value => value.changes?.some(change => change.path === selected))).toBe(true);
      else if (mode === "poll") expect(values).toEqual([]);
      if (mode === "poll") expect(values.every(value => value.reason === "reconcile")).toBe(true);
      values.length = 0;
    }
  }, 30_000);

  test("reconciles a watched subdirectory renamed away and recreated", async () => {
    const selected = path.join("src", "selected.ts");
    await fs.mkdir(path.join(directory, "src"));
    await fs.writeFile(path.join(directory, selected), "before");
    const diagnostics = watchDiagnostics(selected);
    const values: WatchInvalidation[] = [];
    const authority = await root(directory);
    owner = watch(authority, { mode, scopes: [{ path: "src", kind: "tree" }], intervalMs: 60_000,
      onInvalidate: value => { diagnostics.invalidation(value); values.push(value); },
    });
    await owner.ready; await diagnostics.quiet(owner); values.length = 0;
    fsSync.renameSync(path.join(directory, "src"), path.join(directory, "old"));
    fsSync.mkdirSync(path.join(directory, "src"));
    fsSync.writeFileSync(path.join(directory, selected), "replacement");
    fsSync.writeFileSync(path.join(directory, "old", "unobserved.tmp"), "stale watch");
    fsSync.unlinkSync(path.join(directory, "old", "unobserved.tmp"));
    await owner.reconcile(); await diagnostics.quiet(owner);
    expect(values.some(value => value.reason === "overflow" || value.changes?.some(change => change.path === "src" && change.type === "structural"))).toBe(true);
    expect(values.flatMap(value => value.changes ?? []).some(change => change.path.endsWith("unobserved.tmp"))).toBe(false);
    expect(await authority.readText(selected)).toBe("replacement");
    values.length = 0;
    await fs.writeFile(path.join(directory, selected), "replacement edit");
    if (mode === "events") await expect.poll(() => values.some(value => value.reason === "event" && value.changes?.some(change => change.path === selected)), { timeout: 5000 }).toBe(true);
    await diagnostics.quiet(owner); detailed(values, selected);
    expect(owner.health().failure).toBeUndefined();
  }, 30_000);

  test("ignores creation, deletion and recreation of an excluded build tree with thousands of files", async () => {
    await fs.mkdir(path.join(directory, "dist"));
    await fs.writeFile(path.join(directory, "selected.ts"), "before");
    const values: WatchInvalidation[] = [];
    let backendOverflows = 0, reconciledOverflows = 0, consumedOverflows = 0, spuriousOverflows = 0;
    hooks({ afterWatchBackendOverflow: (_, phase) => {
      if (phase === "received") backendOverflows++; else reconciledOverflows++;
    } });
    const allowBackendOverflow = mode === "events" && process.platform !== "linux";
    const assertBurst = () => {
      expect(spuriousOverflows).toBe(0);
      if (allowBackendOverflow) {
        expect(values.every(value => value.reason === "overflow" && value.changes === undefined)).toBe(true);
        expect(values.length).toBeLessThanOrEqual(8);
      } else expect(values).toEqual([]);
    };
    owner = watch(await root(directory), {
      mode, scopes: [{ path: "", kind: "tree" }], intervalMs: 60_000,
      // The workload tests selection; genuine native detail exhaustion is a separate contract.
      maxPendingPaths: 4096, exclude: entry => entry.kind === "directory" && entry.path === "dist",
      onInvalidate: value => {
        if (value.reason === "overflow") {
          if (reconciledOverflows <= consumedOverflows) spuriousOverflows++;
          consumedOverflows = reconciledOverflows;
        }
        values.push(value);
      },
    });
    await owner.ready; await settle(); values.length = 0;
    for (let cycle = 0; cycle < 2; cycle++) {
      await fs.rm(path.join(directory, "dist"), { recursive: true }); await settle();
      assertBurst();
      await fs.mkdir(path.join(directory, "dist"));
      for (let start = 0; start < 2048; start += 32) {
        await Promise.all(Array.from({ length: 32 }, (_, index) => fs.writeFile(path.join(directory, "dist", `file-${start + index}`), "build output")));
      }
      await settle(); assertBurst();
    }
    const overflows = values.length;
    values.length = 0;
    await fs.writeFile(path.join(directory, "selected.ts"), "selected edit");
    if (mode === "events") await expect.poll(() => values.length, { timeout: 5000 }).toBeGreaterThan(0);
    await settle(); detailed(values, "selected.ts");
    expect(owner.health().failure).toBeUndefined();
    console.log(JSON.stringify({ proof: "watch-excluded-build", platform: process.platform, mode, files: 4096, overflows, backendOverflows, spuriousOverflows, detailedDeliveryResumed: true }));
  }, 60_000);

  test("keeps Config entry scopes quiet during heavy sibling churn and details selected edits", async () => {
    const diagnostics = watchDiagnostics("config.json");
    try {
      await fs.writeFile(path.join(directory, "config.json"), "before");
      const values: WatchInvalidation[] = [];
      owner = watch(await root(directory), { mode, scopes: [{ path: "config.json", kind: "entry" }], intervalMs: 60_000,
        onInvalidate: value => { diagnostics.invalidation(value); values.push(value); },
      });
      await owner.ready;
      diagnostics.phase("fixture-drain");
      // FSEvents may deliver setup creation after ready. Establish real delivery
      // and drain trailing events before the strict sibling-only measurement.
      await fs.writeFile(path.join(directory, "config.json"), "fixture sentinel edit");
      if (mode === "events") await expect.poll(() => values.some(value => value.reason === "event" && value.changes?.some(change => change.path === "config.json")), { timeout: 5000 }).toBe(true);
      await diagnostics.quiet(owner);
      values.length = 0;
      diagnostics.phase("sibling-churn");
      for (let cycle = 0; cycle < 32; cycle++) {
        const names = Array.from({ length: 32 }, (_, n) => path.join(directory, `sibling-${n}`));
        await Promise.all(names.map(name => fs.mkdir(name)));
        await Promise.all(names.map(name => fs.writeFile(path.join(name, "unselected"), "noise")));
        await Promise.all(names.map(name => fs.rm(name, { recursive: true })));
      }
      await settle(); expect(values).toEqual([]);
      diagnostics.phase("selected-edit");
      await fs.writeFile(path.join(directory, "config.json"), "selected config edit");
      if (mode === "events") await expect.poll(() => values.length, { timeout: 5000 }).toBeGreaterThan(0);
      await settle(); detailed(values, "config.json");
      console.log(JSON.stringify({ proof: "watch-config-siblings", platform: process.platform, mode, siblingOperations: 3072, overflows: 0, diagnostic: diagnostics.report().selectedHints }));
    } catch (error) {
      console.error(JSON.stringify({ proof: "watch-config-failure", mode, platform: process.platform, ...diagnostics.report() }));
      throw error;
    }
  }, 60_000);
});

it.skipIf(!events)("preserves detail through slow selected-path passes and coalesces pending hints", async () => {
  const native = getNativeBinding()!;
  const register = native.watchRegister!;
  vi.spyOn(native, "watchRegister").mockImplementation((root, limit, _callback, persistent) => register(root, limit, () => {}, persistent));
  let emit!: (batch: NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  await fs.writeFile(path.join(directory, "selected"), "before");
  const values: WatchInvalidation[] = [];
  owner = watch(await root(directory), { mode: "events", scopes: [{ path: "selected", kind: "entry" }], intervalMs: 60_000,
    onInvalidate: value => { values.push(value); },
  });
  await owner.ready; await owner.reconcile(); values.length = 0;
  let passes = 0;
  const hint = () => emit({ overflow: false, hints: [{ directory: "", name: "selected", event: "change" }] });
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  hooks({ beforeWatchRegistration: async () => {
    const pass = ++passes;
    await delay(40); // Deterministically exceed the old 25 ms scan-duration rule.
    if (pass < 4) {
      await fs.writeFile(path.join(directory, "selected"), `edit-${pass}`);
      for (let n = 0; n < 100; n++) hint();
    } else done();
  } });
  hint(); await owner.reconcile(); await completed; await owner.reconcile();
  detailed(values, "selected");
  expect(values.every(value => value.reason === "event")).toBe(true);
  expect(passes).toBeGreaterThanOrEqual(4);
  expect(passes).toBeLessThanOrEqual(5);
});
