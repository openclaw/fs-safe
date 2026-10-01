import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import type { NativeBinding } from "../src/native.js";
import * as native from "../src/watch-native.js";
import * as aliases from "../src/watch-alias.js";
import { __setFsSafeTestHooksForTest as hooks } from "../src/test-hooks.js";
import { watch, type WatchInvalidation, type WatchScope, type WatchSubscription } from "../src/watch.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const scopes: readonly WatchScope[] = [{ path: "MEMORY.md", kind: "entry" }, { path: "USER.md", kind: "entry" }, { path: "memory", kind: "tree", depth: 128 }];
let directory: string, owner: WatchSubscription | undefined, emit: (batch: native.NativeWatchBatch) => void;
let visits: string[], values: WatchInvalidation[], passes: number;
beforeEach(async () => {
  directory = await tempRoot("watch-hint-scheduling-"); visits = []; values = []; passes = 0;
  for (const name of ["MEMORY.md", "USER.md", "sibling"]) await fs.writeFile(path.join(directory, name), "before");
  for (const dir of ["a", "b"]) {
    await fs.mkdir(path.join(directory, "memory", dir), { recursive: true });
    for (let n = 0; n < 8; n++) await fs.writeFile(path.join(directory, "memory", dir, `f${n}`), "before");
  }
  // Inject only transport hints; every observation and identity check uses real disk.
  vi.spyOn(native, "watchBinding").mockReturnValue({ watchRegister: () => 1, watchAdd() {}, watchConfigure() {},
    watchEntries: () => ({ changed: false, directories: 0 }), watchUnregister() {},
  } as unknown as NativeBinding);
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
});
afterEach(async () => { hooks(); await owner?.close(); owner = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
async function start(options: Partial<Parameters<typeof watch>[1]> = {}) {
  owner = watch(await root(directory), { mode: "events", scopes, intervalMs: 60_000,
    exclude(entry) { visits.push(entry.path); return false; },
    onInvalidate(value) { values.push(value); }, onHealth(value) { if (value.state === "ready") passes++; }, ...options,
  });
  await owner.ready; await immediate(); visits.length = 0; values.length = 0; passes = 0;
}
const hint = (directory: string, name: string, event: "change" | "rename" = "change"): native.NativeWatchBatch => ({
  hints: [{ directory, name, event }], overflow: false,
});
async function scanned(batch: native.NativeWatchBatch) {
  const before = passes; emit(batch);
  await expect.poll(() => passes, { timeout: 3000, interval: 10 }).toBeGreaterThan(before);
  await immediate();
}
async function unrelated(batch: native.NativeWatchBatch) {
  const admission = vi.spyOn(aliases, "admittedNativeChanges");
  emit(batch);
  await expect.poll(() => admission.mock.results.length, { timeout: 3000, interval: 10 }).toBeGreaterThan(0);
  await admission.mock.results[0]!.value;
  await immediate(); admission.mockRestore();
}

it("does not schedule a memory crawl for a guarded unrelated root-sibling edit", async () => {
  await start();
  await fs.writeFile(path.join(directory, "sibling"), "unrelated change");
  await unrelated(hint("", "sibling"));
  expect(visits).toEqual([]); expect(passes).toBe(0); expect(values).toEqual([]);
});

it("reconciles a relevant directory and its chain without crawling sibling subtrees", async () => {
  await start();
  const selected = path.join("memory", "a", "f0");
  await fs.writeFile(path.join(directory, selected), "selected content changed");
  await scanned(hint(path.join("memory", "a"), "f0"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
  expect(visits).toContain(selected);
  expect(visits).not.toContain(path.join("memory", "b", "f0"));
  expect(visits.length).toBeLessThan(16);
  values.length = 0; visits.length = 0;
  await fs.writeFile(path.join(directory, "memory/b/f0"), "missed native hint");
  await owner!.reconcile();
  expect(values).toEqual([{ reason: "reconcile", changes: [{ path: path.join("memory", "b", "f0"), type: "content" }] }]);
});

it("reconciles a selected entry without listing the memory tree", async () => {
  await start();
  await fs.writeFile(path.join(directory, "MEMORY.md"), "selected entry changed");
  await scanned(hint("", "MEMORY.md"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: "MEMORY.md", type: "content" }] }]);
  expect(visits).toEqual(["MEMORY.md", "USER.md", "memory"]);
});

it.each(["entry", "tree"] as const)("observes writes through a cross-directory hard link for a selected %s", async kind => {
  const selected = path.join("memory", "a", "f0");
  await fs.link(path.join(directory, selected), path.join(directory, "alias"));
  await start({ scopes: [{ path: kind === "entry" ? selected : "memory", kind }] });
  await fs.writeFile(path.join(directory, "alias"), "written through another parent");
  await scanned(hint("", "alias"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
});

it.each(["entry", "subtree", "root-tree"])("reconciles a hard-link write after the hint leaf vanishes (%s)", async selection => {
  const selected = path.join("memory", "a", "f0"), alias = path.join(directory, "alias");
  await start({ scopes: [{ path: selection === "entry" ? selected : selection === "subtree" ? "memory" : "", kind: selection === "entry" ? "entry" : "tree" }] });
  await fs.link(path.join(directory, selected), alias);
  await fs.writeFile(alias, "written through a now-vanished alias");
  await fs.unlink(alias);
  // Even a modification-only batch may outlive the leaf it named.
  await scanned(hint("", "alias"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
});

it("reconciles namespace activity after a hard-link alias becomes an unrelated single-link file", async () => {
  const selected = path.join("memory", "a", "f0"), alias = path.join(directory, "alias");
  await start();
  await fs.link(path.join(directory, selected), alias);
  await fs.writeFile(alias, "selected content changed before replacement");
  await fs.unlink(alias); await fs.writeFile(alias, "now unrelated");
  await scanned(hint("", "alias", "rename"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
});

it("refreshes old hard-link peers when a selected name is replaced by a single-link file", async () => {
  const selected = path.join("memory", "a", "f0"), alias = path.join("memory", "b", "link");
  await fs.link(path.join(directory, selected), path.join(directory, alias));
  await start();
  await fs.writeFile(path.join(directory, selected), "old inode updated");
  await fs.unlink(path.join(directory, selected));
  await fs.writeFile(path.join(directory, selected), "new inode");
  await scanned(hint(path.join("memory", "a"), "f0", "rename"));
  expect(values.flatMap(value => value.changes ?? [])).toEqual(expect.arrayContaining([
    { path: selected, type: "structural" }, { path: alias, type: "content" },
  ]));
});

it.each([false, true])("refreshes selected hard-link peers (link created after baseline: %s)", async afterBaseline => {
  const selected = path.join("memory", "a", "f0"), alias = path.join("memory", "b", "link");
  if (!afterBaseline) await fs.link(path.join(directory, selected), path.join(directory, alias));
  await start();
  if (afterBaseline) await fs.link(path.join(directory, selected), path.join(directory, alias));
  await fs.writeFile(path.join(directory, selected), "both linked paths changed");
  await scanned(hint(path.join("memory", "a"), "f0"));
  const changes = values.flatMap(value => value.changes ?? []);
  expect(changes).toHaveLength(2);
  expect(changes).toContainEqual({ path: selected, type: "content" });
  expect(changes).toContainEqual({ path: alias, type: afterBaseline ? "structural" : "content" });
});

it("does not let excluded hints hide a selected hard-link write in a mixed batch", async () => {
  const selected = path.join("memory", "a", "f0");
  await fs.link(path.join(directory, selected), path.join(directory, "excluded"));
  await start({ scopes: [{ path: "", kind: "tree" }],
    exclude: entry => entry.path === "excluded",
  });
  await fs.writeFile(path.join(directory, "excluded"), "selected data changed through excluded alias");
  await scanned({ hints: [...hint("", "excluded").hints, ...hint("", "vanished-unrelated").hints], overflow: false });
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
});

it("reconciles queued hints that become excluded during an in-flight full pass", async () => {
  const selected = path.join("memory", "a", "f0");
  let writeDuringScan = false;
  await start({ scopes: [{ path: "", kind: "tree" }], exclude(entry) {
    if (writeDuringScan && entry.path === selected) {
      writeDuringScan = false;
      writeFileSync(path.join(directory, "excluded"), "write after the leaf's metadata observation");
      emit({ hints: [...hint("", "excluded").hints, ...hint("", "vanished-unrelated").hints], overflow: false });
    }
    return entry.path === "excluded";
  } });
  await fs.link(path.join(directory, selected), path.join(directory, "excluded"));
  writeDuringScan = true;
  await owner!.reconcile();
  await expect.poll(() => values.flatMap(value => value.changes ?? [])).toContainEqual({ path: selected, type: "content" });
  expect(values.flatMap(value => value.changes ?? []).every(change => change.path === selected)).toBe(true);
});

it.each(["overflow", "no details", "mixed no details"])("fully reconciles %s batches", async scenario => {
  await start();
  await fs.writeFile(path.join(directory, "memory/b/f0"), "unhinted change");
  const before = passes;
  emit({ hints: [], overflow: scenario === "overflow" });
  if (scenario === "mixed no details") emit(hint(path.join("memory", "a"), "f0"));
  await expect.poll(() => passes).toBeGreaterThan(before);
  expect(visits).toContain(path.join("memory", "a", "f0"));
  expect(visits).toContain(path.join("memory", "b", "f0"));
  if (scenario === "overflow") expect(values).toEqual([{ reason: "overflow", changes: undefined }]);
  else expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "b", "f0"), type: "content" });
});

it("discovers new directories and removes obsolete subtree snapshots before publishing", async () => {
  await start();
  await fs.rename(path.join(directory, "memory/a"), path.join(directory, "retired"));
  await fs.mkdir(path.join(directory, "memory/a/new"), { recursive: true });
  await fs.writeFile(path.join(directory, "memory/a/new/created"), "new subtree");
  await scanned(hint("memory", "a", "rename"));
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "a", "new", "created"), type: "structural" });
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "a", "f0"), type: "structural" });
  expect(owner!.health().failure).toBeUndefined();
});

it("discovers descendant registrations when a coarse directory hint retains the directory inode", async () => {
  const registrations = vi.spyOn(native.watchBinding("events")!, "watchAdd");
  await start();
  await fs.mkdir(path.join(directory, "memory/a/new"));
  await fs.writeFile(path.join(directory, "memory/a/new/file"), "new descendant");
  await scanned(hint("memory", "a", "rename"));
  expect(owner!.health().directories).toBe(5);
  expect(registrations).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ relative: path.join("memory", "a", "new") }));
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "a", "new", "file"), type: "structural" });
});

it("keeps the full-snapshot entry budget across incremental directory growth", async () => {
  await start({ maxEntries: 21 }); // Three targets, two directories, sixteen files.
  await fs.writeFile(path.join(directory, "memory/a/new"), "over budget");
  emit(hint(path.join("memory", "a"), "new", "rename"));
  await expect.poll(() => owner!.health().state).toBe("unavailable");
  expect(owner!.health().failure?.error).toMatchObject({ code: "too-large" });
  expect(values).toEqual([]);
});

it("falls back to a full pass when repeated slice ancestors exhaust a tight budget", async () => {
  await start({ scopes: [{ path: path.join("memory", "a"), kind: "tree" }], maxEntries: 10 });
  await fs.writeFile(path.join(directory, "memory/a/f0"), "changed within the original budget");
  await scanned(hint(path.join("memory", "a"), "f0"));
  expect(owner!.health().failure).toBeUndefined();
  expect(values).toEqual([{ reason: "event", changes: [{ path: path.join("memory", "a", "f0"), type: "content" }] }]);
});

it("retains filesystem spelling aliases when deciding relevance", async context => {
  const lower = await fs.lstat(path.join(directory, "memory.md"), { bigint: true }).catch(() => undefined);
  if (!lower) { context.skip("case-sensitive fixture"); return; }
  expect(lower.ino).toBe((await fs.lstat(path.join(directory, "MEMORY.md"), { bigint: true })).ino);
  await start();
  await scanned(hint("", "memory.md"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: "MEMORY.md", type: "structural" }] }]);
});

it.for(["creation", "deletion", "replacement"])("reconciles selected alias %s without a surviving baseline hint identity", async (operation, context) => {
  if (!await fs.lstat(path.join(directory, "memory.md")).catch(() => undefined)) { context.skip("case-sensitive fixture"); return; }
  if (operation === "creation") await fs.unlink(path.join(directory, "MEMORY.md"));
  await start();
  if (operation === "creation") await fs.writeFile(path.join(directory, "Memory.md"), "new target");
  else if (operation === "deletion") await fs.unlink(path.join(directory, "MEMORY.md"));
  else {
    await fs.writeFile(path.join(directory, "replacement"), "new inode");
    await fs.rename(path.join(directory, "replacement"), path.join(directory, "MEMORY.md"));
  }
  await scanned(hint("", "memory.md", "rename"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: "MEMORY.md", type: "structural" }] }]);
});

it("discovers a missing tree through an alias of its nearest guarded anchor", async context => {
  if (!await fs.lstat(path.join(directory, "MEMORY")).catch(() => undefined)) { context.skip("case-sensitive fixture"); return; }
  await fs.rm(path.join(directory, "memory"), { recursive: true });
  await start({ scopes: [{ path: "MEMORY", kind: "tree" }] });
  await fs.mkdir(path.join(directory, "memory/a"), { recursive: true });
  await fs.writeFile(path.join(directory, "memory/a/new"), "new child");
  await scanned(hint("", "memory", "rename"));
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("MEMORY", "a", "new"), type: "structural" });
});

it("refreshes every selected spelling when entry and tree scopes physically overlap", async context => {
  if (!await fs.lstat(path.join(directory, "MEMORY")).catch(() => undefined)) { context.skip("case-sensitive fixture"); return; }
  const alias = path.join("MEMORY", "a", "f0");
  await start({ scopes: [{ path: "memory", kind: "tree" }, { path: alias, kind: "entry" }] });
  await fs.writeFile(path.join(directory, alias), "both spellings changed");
  await scanned(hint(path.join("MEMORY", "a"), "f0"));
  expect(values).toEqual([{ reason: "event", changes: [
    { path: path.join("memory", "a", "f0"), type: "content" }, { path: alias, type: "content" },
  ] }]);
});

it("does not discard tree changes reported through an aliased entry parent", async context => {
  if (!await fs.lstat(path.join(directory, "MEMORY")).catch(() => undefined)) { context.skip("case-sensitive fixture"); return; }
  await start({ scopes: [{ path: "memory", kind: "tree" }, { path: path.join("MEMORY", "a", "f0"), kind: "entry" }] });
  await fs.writeFile(path.join(directory, "memory/a/f1"), "tree-only entry changed");
  await scanned(hint(path.join("MEMORY", "a"), "f1"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: path.join("memory", "a", "f1"), type: "content" }] }]);
});

it("recognizes physical overlap with a directory entry that has no separate registration", async context => {
  if (!await fs.lstat(path.join(directory, "MEMORY")).catch(() => undefined)) { context.skip("case-sensitive fixture"); return; }
  await start({ scopes: [{ path: "memory", kind: "tree" }, { path: "MEMORY", kind: "entry" }] });
  await fs.writeFile(path.join(directory, "memory/a/f1"), "child changed");
  await scanned(hint("", "MEMORY"));
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "a", "f1"), type: "content" });
});

it("fully reconciles an affected directory when an exclusion prevents its partial listing", async () => {
  let excludeBranch = false;
  const branch = path.join("memory", "a");
  await start({ exclude(entry) { return excludeBranch && entry.path === branch; } });
  excludeBranch = true;
  await scanned(hint(branch, "f0"));
  const changes = values.flatMap(value => value.changes ?? []);
  expect(changes).toContainEqual({ path: branch, type: "structural" });
  expect(changes).toContainEqual({ path: path.join(branch, "f0"), type: "structural" });
  expect(changes.every(change => change.type === "structural")).toBe(true);
  expect(owner!.health().directories).toBe(3);
  values.length = 0;
  await owner!.reconcile();
  expect(values).toEqual([]);
});

it("does not follow a symbolic alias into a selected tree", async () => {
  await fs.symlink(path.join(directory, "memory"), path.join(directory, "link"), process.platform === "win32" ? "junction" : "dir");
  await start();
  await fs.writeFile(path.join(directory, "memory/a/f0"), "changed through alias");
  await scanned(hint(path.join("link", "a"), "f0"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: path.join("memory", "a", "f0"), type: "content" }] }]);
  expect(visits.every(name => !name.startsWith("link"))).toBe(true);
});

it("reconciles a swapped scope anchor even with an unrelated sibling hint", async () => {
  const outside = await tempRoot("watch-hint-outside-");
  await fs.writeFile(path.join(outside, "OUTSIDE_SENTINEL"), "private");
  await start();
  await fs.rename(path.join(directory, "memory"), path.join(directory, "retired"));
  await fs.symlink(outside, path.join(directory, "memory"), process.platform === "win32" ? "junction" : "dir");
  await scanned(hint("", "sibling"));
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: "memory", type: "structural" });
  expect(JSON.stringify(values)).not.toContain("OUTSIDE_SENTINEL");
  expect(visits).not.toContain(path.join("memory", "OUTSIDE_SENTINEL"));
});

it("fails closed on a directory-to-symlink swap after hint admission", async () => {
  const outside = await tempRoot("watch-hint-race-outside-");
  await fs.writeFile(path.join(outside, "OUTSIDE_SENTINEL"), "private");
  await start();
  let swapped = false;
  hooks({ beforeWatchRegistration: async name => {
    if (swapped || name !== path.join(directory, "memory", "a")) return;
    swapped = true;
    await fs.rename(name, path.join(directory, "retired"));
    await fs.symlink(outside, name, process.platform === "win32" ? "junction" : "dir");
  } });
  await scanned(hint(path.join("memory", "a"), "f0"));
  expect(swapped).toBe(true);
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "a"), type: "structural" });
  expect(JSON.stringify(values)).not.toContain("OUTSIDE_SENTINEL");
  expect(visits).not.toContain(path.join("memory", "a", "OUTSIDE_SENTINEL"));
  expect(owner!.health().failure).toBeUndefined();
});

it("uses enumerated spelling and preserves deletion-before-creation detail for a case rename", async () => {
  await start();
  await fs.rename(path.join(directory, "memory/a/f0"), path.join(directory, "memory/a/F0"));
  await scanned(hint(path.join("memory", "a"), "F0", "rename"));
  expect(values).toEqual([{ reason: "event", changes: [
    { path: path.join("memory", "a", "f0"), type: "structural" },
    { path: path.join("memory", "a", "F0"), type: "structural" },
  ] }]);
});

it("fully reconciles overlapping tree scopes without retaining ghost descendants", async () => {
  await start({ scopes: [{ path: "memory", kind: "tree", depth: 1 }, { path: path.join("memory", "a"), kind: "tree" }] });
  await fs.rm(path.join(directory, "memory/a/f0"));
  await scanned(hint(path.join("memory", "a"), "f0", "rename"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: path.join("memory", "a", "f0"), type: "structural" }] }]);
  values.length = 0;
  await owner!.reconcile();
  expect(values).toEqual([]);
});

it("runs periodic full reconciliation during a continuous stream of relevant hints", async () => {
  await start({ intervalMs: 80 });
  await fs.writeFile(path.join(directory, "memory/b/f0"), "unhinted edit");
  for (let i = 0; i < 16; i++) { emit(hint(path.join("memory", "a"), "f0")); await delay(20); }
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "b", "f0"), type: "content" });
  expect(owner!.health().failure).toBeUndefined();
});

it("does not turn a periodic request during a slow partial scan into continuous full scans", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
  };
  const partialEntered = gate(), releasePartial = gate(), fullEntered = gate(), releaseFull = gate(), fullReady = gate();
  let starts = 0, registrations = 0;
  await start({ intervalMs: 80, onHealth(health) {
    if (health.state === "reconciling") starts++;
    if (health.state === "ready" && registrations === 2) fullReady.resolve();
  } });
  hooks({ beforeWatchRegistration: async name => {
    if (name !== directory) return;
    if (++registrations === 1) { partialEntered.resolve(); await releasePartial.promise; }
    else if (registrations === 2) { fullEntered.resolve(); await releaseFull.promise; }
  } });
  try {
    emit(hint(path.join("memory", "a"), "f0"));
    await vi.advanceTimersByTimeAsync(25); await partialEntered.promise;
    await vi.advanceTimersByTimeAsync(80);
    releasePartial.resolve(); await fullEntered.promise;
    await vi.advanceTimersByTimeAsync(160);
    releaseFull.resolve(); await fullReady.promise; await immediate();
    expect(starts).toBe(2);
    await vi.advanceTimersByTimeAsync(79);
    expect(starts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toBe(3);
  } finally { releasePartial.resolve(); releaseFull.resolve(); }
});

const folded = (directory: string): native.NativeWatchBatch => ({
  hints: [{ directory, name: "", event: "subtree" }], overflow: false,
});
it("drops an unrelated folded directory without a crawl or invalidation", async () => {
  await fs.mkdir(path.join(directory, "noise"));
  await start();
  await unrelated(folded("noise"));
  expect(visits).toEqual([]); expect(passes).toBe(0); expect(values).toEqual([]);
});
it("reconciles a folded ancestor of a missing TREE with only observed diff detail", async () => {
  await start({ scopes: [{ path: path.join("memory", "missing"), kind: "tree" }] });
  await fs.mkdir(path.join(directory, "memory", "missing"));
  await fs.writeFile(path.join(directory, "memory", "missing", "created"), "selected");
  await scanned(folded("memory"));
  expect(values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("memory", "missing", "created"), type: "structural" });
  expect(values.every(value => value.reason !== "overflow")).toBe(true);
  expect(values.flatMap(value => value.changes ?? []).some(change => change.path === "memory")).toBe(false);
});
it("fully reconciles folded tree territory without publishing the hint directory", async () => {
  await start();
  const selected = path.join("memory", "a", "f0");
  await fs.writeFile(path.join(directory, selected), "changed");
  await scanned(folded(path.join("memory", "a")));
  expect(visits).toContain(path.join("memory", "b", "f0"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
});
it("admits a folded directory spelling alias by guarded identity", async context => {
  if (!await fs.lstat(path.join(directory, "MEMORY")).catch(() => undefined)) { context.skip("case-sensitive fixture"); return; }
  await start();
  const selected = path.join("memory", "a", "f0");
  await fs.writeFile(path.join(directory, selected), "changed");
  await scanned(folded("MEMORY"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: selected, type: "content" }] }]);
});
it("degrades coalesced JS hint pressure to a full diff without overflow", async () => {
  await start({ maxPendingPaths: 2 });
  await fs.writeFile(path.join(directory, "MEMORY.md"), "changed");
  // Separate native batches each fit; the JS coalescing window does not.
  emit(hint("", "unrelated-a")); emit(hint("", "unrelated-b"));
  await scanned(hint("", "unrelated-c"));
  expect(values).toEqual([{ reason: "event", changes: [{ path: "MEMORY.md", type: "content" }] }]);
});
