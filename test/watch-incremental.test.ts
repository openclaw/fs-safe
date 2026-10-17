import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { setTimeout as settle } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import * as scan from "../src/watch-scan.js";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { loadTestNative } from "./helpers/native-probe.js";

const { tempRoot } = useRealTempDirs();
const nativeAvailable = !!loadTestNative("optional");
let owner: WatchSubscription | undefined;
let completed: (() => void) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await owner?.close(); owner = undefined;
  vi.useRealTimers(); __resetFsSafeNativeConfigForTest();
});

async function fixture(options: { fullReconcileIntervalMs?: number; exclude?: () => boolean; nativeMode?: "off" | "require"; fixedMtime?: boolean } = {}) {
  const { nativeMode = "off", fixedMtime, ...watchOptions } = options;
  configureFsSafeNative({ mode: nativeMode });
  const directory = await tempRoot("watch-incremental-");
  for (let n = 0; n < 16; n++) {
    const child = path.join(directory, `d${n}`, "deep");
    fs.mkdirSync(child, { recursive: true });
    for (let file = 0; file < 3; file++) fs.writeFileSync(path.join(child, `f${file}`), "before");
  }
  if (fixedMtime) fs.utimesSync(path.join(directory, "d4", "deep", "f1"), 1_700_000_000, 1_700_000_000);
  await settle(1100);
  const changes: WatchInvalidation[] = [];
  const capability = await root(directory);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  owner = watch(capability, { mode: "poll", scopes: [{ path: "", kind: "tree" }],
    pollIntervalMs: 1000, ...watchOptions, onInvalidate: change => { changes.push(change); },
    onHealth: health => { if (health.state === "ready") completed?.(); },
  });
  await owner.ready;
  changes.length = 0;
  const tick = async () => {
    const ready = new Promise<void>(resolve => { completed = resolve; });
    await vi.advanceTimersByTimeAsync(1000); await ready; completed = undefined;
  };
  return { directory, changes, tick };
}

for (const nativeMode of ["off", "require"] as const) it.skipIf(nativeMode === "require" && !nativeAvailable)(`pins the idle per-tick budget (${nativeMode}): no directory listings, only linear metadata probes`, async () => {
  const { changes, tick } = await fixture({ nativeMode });
  const listing = vi.spyOn(fsPromises, "opendir");
  const metadata = vi.spyOn(fs, "lstatSync");
  const guardedScan = vi.spyOn(scan, "scanWatch");
  for (let n = 0; n < 2; n++) {
    listing.mockClear(); metadata.mockClear();
    await tick();
    expect(listing).not.toHaveBeenCalled();
    expect(guardedScan).not.toHaveBeenCalled();
    expect(metadata.mock.calls.length).toBeLessThanOrEqual(140); // 2 * 33 dirs + 48 leaves + Root fences
    expect(changes).toEqual([]);
  }
});

it("lists only a changed directory and its new descendants", async () => {
  const { directory, changes, tick } = await fixture();
  fs.mkdirSync(path.join(directory, "d0", "deep", "new"));
  fs.writeFileSync(path.join(directory, "d0", "deep", "new", "file"), "new");
  const listing = vi.spyOn(fsPromises, "opendir");
  await tick();
  expect(listing.mock.calls.map(([name]) => path.relative(directory, String(name))).sort()).toEqual([
    "d0", path.join("d0", "deep"), path.join("d0", "deep", "new"),
  ].sort());
  expect(changes.flatMap(change => change.changes ?? []).map(change => change.path)).toContain(path.join("d0", "deep", "new", "file"));
});

it("checks files even when their parent's metadata and the file mtime are unchanged", async () => {
  const { directory, changes, tick } = await fixture({ fixedMtime: true });
  const file = path.join(directory, "d4", "deep", "f1");
  fs.writeFileSync(file, "after!");
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  const listing = vi.spyOn(fsPromises, "opendir");
  await tick();
  expect(listing.mock.calls.map(([name]) => String(name))).toEqual([path.dirname(file)]);
  expect(changes.flatMap(change => change.changes ?? [])).toContainEqual({ path: path.relative(directory, file), type: "content" });
});

it.each(["symlink", "directory", "ancestor", "rename", "hardlink"] as const)("fences a deep %s substitution during the metadata probe", async substitution => {
  const { directory, changes, tick } = await fixture();
  const outside = await tempRoot("watch-incremental-outside-");
  const child = path.join(directory, "d4", "deep");
  const leaf = path.join(child, "f1");
  const original = fs.lstatSync;
  let replaced = false;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options: { bigint?: boolean }) => {
    const result = original(name, options as { bigint: true });
    if (!replaced && String(name) === leaf) {
      replaced = true;
      if (substitution === "hardlink") fs.linkSync(leaf, path.join(outside, "linked"));
      else {
        const selected = substitution === "ancestor" ? path.dirname(child) : child;
        fs.renameSync(selected, path.join(outside, "moved"));
        if (substitution === "symlink" || substitution === "ancestor") fs.symlinkSync(path.join(outside, "moved"), selected, process.platform === "win32" ? "junction" : "dir");
        else {
          fs.mkdirSync(selected);
          fs.writeFileSync(path.join(selected, "replacement"), "fixture");
        }
      }
    }
    return result;
  }) as typeof fs.lstatSync);
  await tick();
  if (substitution === "hardlink") await tick(); // The link is created after this leaf's stat.
  expect(replaced).toBe(true);
  expect(owner!.health().state).toBe("ready");
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.flatMap(change => change.changes ?? []).some(change => change.path.includes("outside"))).toBe(false);
  if (substitution === "hardlink") {
    // Root consumers still reject multiply-linked regular files.
    await expect((await root(directory)).readText(path.relative(directory, leaf))).rejects.toMatchObject({ code: "hardlink" });
  }
});

it("keeps explicit reconciliation and the safety-net cadence fully guarded", async () => {
  const { tick } = await fixture({ fullReconcileIntervalMs: 20 });
  const listing = vi.spyOn(fsPromises, "opendir");
  // Monotonic time, independent of mocked timers, drives safety-net expiry.
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 1000);
  await tick();
  expect(listing.mock.calls.length).toBe(33);
  listing.mockClear();
  await owner!.reconcile();
  expect(listing.mock.calls.length).toBe(33);
});

it("falls back to a full guarded pass on a metadata error", async () => {
  const { directory, tick } = await fixture();
  const original = fs.lstatSync;
  let failed = false;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options: { bigint?: boolean }) => {
    if (!failed && String(name) === path.join(directory, "d3")) {
      failed = true; throw Object.assign(new Error("transient"), { code: "EIO" });
    }
    return original(name, options as { bigint: true });
  }) as typeof fs.lstatSync);
  const listing = vi.spyOn(fsPromises, "opendir");
  await tick();
  expect(failed).toBe(true);
  expect(listing.mock.calls.length).toBe(33);
});

it("uses full scans on filesystems with coarse timestamps", async () => {
  const original = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options: { bigint?: boolean }) => {
    const stat = original(name, options as { bigint: true });
    if (typeof stat.mtimeNs === "bigint") {
      stat.mtimeNs -= stat.mtimeNs % 1_000_000_000n;
      stat.ctimeNs -= stat.ctimeNs % 1_000_000_000n;
    }
    return stat;
  }) as typeof fs.lstatSync);
  const { tick } = await fixture();
  const listing = vi.spyOn(fsPromises, "opendir");
  await tick();
  expect(listing.mock.calls.length).toBe(33);
});

it("does not mistake one timestamp-aligned file for a coarse filesystem", async () => {
  const original = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options: { bigint?: boolean }) => {
    const stat = original(name, options as { bigint: true });
    if (String(name).endsWith(path.join("d4", "deep", "f1")) && typeof stat.mtimeNs === "bigint") {
      stat.mtimeNs -= stat.mtimeNs % 1_000_000n;
      stat.ctimeNs -= stat.ctimeNs % 1_000_000n;
    }
    return stat;
  }) as typeof fs.lstatSync);
  const { tick } = await fixture();
  const listing = vi.spyOn(fsPromises, "opendir");
  await tick();
  expect(listing).not.toHaveBeenCalled();
});

it("uses a full scan when an observed clock goes backwards", async () => {
  const { directory, tick } = await fixture();
  const original = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options: { bigint?: boolean }) => {
    const stat = original(name, options as { bigint: true });
    if (String(name) === path.join(directory, "d2") && typeof stat.ctimeNs === "bigint") stat.ctimeNs -= 1_000_000_000n;
    return stat;
  }) as typeof fs.lstatSync);
  const listing = vi.spyOn(fsPromises, "opendir");
  await tick();
  expect(listing.mock.calls.length).toBe(33);
});

it("does not reuse a recent directory timestamp when the clock has not advanced", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("watch-clock-quantum-");
  const capability = await root(directory);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let completedTick: (() => void) | undefined;
  const changes: WatchInvalidation[] = [];
  owner = watch(capability, { mode: "poll", intervalMs: 1000, scopes: [{ path: "", kind: "tree" }],
    onInvalidate(value) { changes.push(value); }, onHealth(value) { if (value.state === "ready") completedTick?.(); },
  });
  await owner.ready; changes.length = 0;
  const stamp = fs.lstatSync(directory, { bigint: true });
  const original = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options: { bigint?: boolean }) =>
    String(name) === directory && options?.bigint ? stamp : original(name, options as { bigint: true })) as typeof fs.lstatSync);
  fs.writeFileSync(path.join(directory, "new-with-same-timestamp"), "changed within a clock quantum");
  vi.spyOn(Date, "now").mockReturnValue(Number(stamp.mtimeNs / 1_000_000n) + 5000);
  const ready = new Promise<void>(resolve => { completedTick = resolve; });
  await vi.advanceTimersByTimeAsync(1000); await ready;
  expect(changes.flatMap(value => value.changes ?? [])).toContainEqual({ path: "new-with-same-timestamp", type: "structural" });
});
