import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchBinding, type NativeWatchBatch } from "../src/watch-native.js";
const nativeWatchSupported = !!watchBinding("auto");
import { getNativeBinding } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
let dir: string;
let owners: WatchSubscription[];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-alias-")); owners = []; });
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  await Promise.all(owners.map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe.each(["events", "poll"] as const)("filesystem scope spelling (%s)", mode => {
  it.skipIf(mode === "events" && !nativeWatchSupported)("uses real filesystem lookup for exact entries and prefix scopes", async () => {
    let emit: ((batch: NativeWatchBatch) => void) | undefined;
    if (mode === "events") {
      // Isolate exact hint detail from the separately tested slow-pass overflow path.
      vi.spyOn(performance, "now").mockReturnValue(0);
      const native = getNativeBinding()!;
      const register = native.watchRegister!;
      // Isolate spelling admission from unrelated native overflow notifications.
      vi.spyOn(native, "watchRegister").mockImplementation((root, limit, _callback, persistent) => register(root, limit, () => {}, persistent));
      __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit ??= callback; } });
    }
    await fs.mkdir(path.join(dir, "MixedDir"));
    await fs.writeFile(path.join(dir, "MixedDir/Entry.TXT"), "before");
    const actual = await fs.lstat(path.join(dir, "MixedDir/Entry.TXT"), { bigint: true });
    const alias = await fs.lstat(path.join(dir, "mixeddir/entry.txt"), { bigint: true }).catch(() => undefined);
    const aliases = alias?.dev === actual.dev && alias?.ino === actual.ino;
    const hints: WatchInvalidation[] = [];
    const entry = watch(await root(dir), { mode, scopes: [{ path: path.join("mixeddir", "entry.txt"), kind: "entry" }], onInvalidate: hint => { hints.push(hint); } }); owners.push(entry);
    const tree = watch(await root(dir), { mode, scopes: [{ path: "mixeddir", kind: "tree" }], onInvalidate() {} }); owners.push(tree);
    await Promise.all([entry.ready, tree.ready]);
    expect(entry.health().directories).toBe(aliases ? 2 : 1);
    expect(tree.health().directories).toBe(aliases ? 2 : 1);
    hints.length = 0;
    if (mode === "events") {
      emit!({ overflow: false, hints: [{ directory: "MixedDir", name: "Entry.TXT", event: "change" }] });
      await entry.reconcile();
      expect(hints).toEqual(aliases ? [{ reason: "event", changes: [{ path: path.join("mixeddir", "entry.txt"), type: "structural" }] }] : []);
      hints.length = 0;
    }
    await fs.writeFile(path.join(dir, "MixedDir/Entry.TXT"), "actual edit");
    await entry.reconcile();
    if (aliases) await expect((await root(dir)).readText("mixeddir/entry.txt")).resolves.toBe("actual edit");
    if (aliases) {
      expect(hints.some(hint => hint.changes === undefined || hint.changes.some(change => change.path === path.join("mixeddir", "entry.txt")))).toBe(true);
    } else {
      expect(hints).toEqual([]);
      await fs.mkdir(path.join(dir, "mixeddir"));
      await fs.writeFile(path.join(dir, "mixeddir/entry.txt"), "distinct selected file");
      await Promise.all([entry.reconcile(), tree.reconcile()]);
      expect(entry.health().directories).toBe(2);
      expect(await (await root(dir)).readText("mixeddir/entry.txt")).toBe("distinct selected file");
      expect(await fs.readFile(path.join(dir, "MixedDir/Entry.TXT"), "utf8")).toBe("actual edit");
    }
  });
});

it.skipIf(!nativeWatchSupported)("retains ambiguity under pending pressure instead of dropping a selected spelling alias", async context => {
  await fs.writeFile(path.join(dir, "Entry.TXT"), "unchanged metadata");
  const actual = await fs.lstat(path.join(dir, "Entry.TXT"), { bigint: true });
  const alias = await fs.lstat(path.join(dir, "entry.txt"), { bigint: true }).catch(() => undefined);
  if (alias?.dev !== actual.dev || alias?.ino !== actual.ino) { context.skip("filesystem has no case alias"); return; }
  const native = getNativeBinding()!;
  const register = native.watchRegister!;
  vi.spyOn(native, "watchRegister").mockImplementation((root, limit, _callback, persistent) => register(root, limit, () => {}, persistent));
  let emit!: (batch: NativeWatchBatch) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const values: WatchInvalidation[] = [];
  const owner = watch(await root(dir), { mode: "events", scopes: [{ path: "entry.txt", kind: "entry" }], maxPendingPaths: 1,
    onInvalidate: value => { values.push(value); },
  });
  owners.push(owner); await owner.ready; await owner.reconcile(); values.length = 0;
  for (const names of [["unrelated", "Entry.TXT"], ["Entry.TXT", "unrelated"]]) {
    emit({ overflow: false, hints: names.map(name => ({ directory: "", name, event: "change" })) });
    await owner.reconcile();
    expect(values).toEqual([{ reason: "overflow", changes: undefined }]);
    values.length = 0;
  }
  emit({ overflow: false, hints: [{ directory: "", name: "Entry.TXT", event: "change" }] });
  await owner.reconcile();
  expect(values).toEqual([{ reason: "event", changes: [{ path: "entry.txt", type: "structural" }] }]);
});

it.skipIf(!nativeWatchSupported)("does not infer a selected identity for unseen names that are already gone", async () => {
  const native = getNativeBinding()!;
  const register = native.watchRegister!;
  vi.spyOn(native, "watchRegister").mockImplementation((root, limit, _callback, persistent) => register(root, limit, () => {}, persistent));
  let emit!: (batch: NativeWatchBatch) => void;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  const values: WatchInvalidation[] = [];
  const owner = watch(await root(dir), { mode: "events", scopes: [{ path: "entry.txt", kind: "entry" }], onInvalidate: value => { values.push(value); } });
  owners.push(owner); await owner.ready; values.length = 0;
  for (const name of ["Entry.TXT", "unselected-sibling"]) {
    await fs.writeFile(path.join(dir, name), "transient");
    await fs.unlink(path.join(dir, name));
    emit({ hints: [{ directory: "", name, event: "rename" }], overflow: false });
    await owner.reconcile();
    expect(values).toEqual([]);
  }
  // The caller's literal target is already admitted independently of the hint.
  emit({ hints: [{ directory: "", name: "entry.txt", event: "rename" }], overflow: false });
  await owner.reconcile();
  expect(values).toEqual([{ reason: "event", changes: [{ path: "entry.txt", type: "structural" }] }]);
});
