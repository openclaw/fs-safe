import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as immediate, setTimeout as settle } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import * as native from "../src/watch-native.js";
import type { NativeBinding } from "../src/native.js";
import { __setFsSafeTestHooksForTest as hooks } from "../src/test-hooks.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let owner: WatchSubscription | undefined;
afterEach(async () => { hooks(); vi.restoreAllMocks(); await owner?.close(); owner = undefined; vi.useRealTimers(); });

async function fixture() {
  const directory = await tempRoot("watch-incremental-hints-");
  await fs.mkdir(path.join(directory, "tree/a/nested"), { recursive: true });
  await fs.mkdir(path.join(directory, "tree/b"));
  await fs.writeFile(path.join(directory, "tree/a/file"), "before");
  await fs.writeFile(path.join(directory, "tree/a/nested/existing"), "before");
  await fs.writeFile(path.join(directory, "tree/b/file"), "before");
  await settle(1100);
  const capability = await root(directory);
  vi.spyOn(native, "watchBinding").mockReturnValue({ watchRegister: () => 1, watchAdd() {}, watchConfigure() {},
    watchEntries: () => ({ changed: false, directories: 0 }), watchUnregister() {},
  } as unknown as NativeBinding);
  let emit!: (batch: native.NativeWatchBatch) => void;
  hooks({ afterWatchBackendCreated: (_, callback) => { emit = callback; } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const values: WatchInvalidation[] = [];
  let complete: (() => void) | undefined;
  const next = () => new Promise<void>(resolve => { complete = resolve; });
  owner = watch(capability, { mode: "events", scopes: [{ path: "tree", kind: "tree" }], intervalMs: 1000,
    onInvalidate(value) { values.push(value); }, onHealth(value) { if (value.state === "ready") complete?.(); },
  });
  await owner.ready; await immediate(); values.length = 0;
  const edit = async () => {
    await fs.writeFile(path.join(directory, "tree/a/file"), "changed content");
    const ready = next();
    emit({ overflow: false, hints: [{ directory: path.join("tree", "a"), name: "file", event: "change" }] });
    await vi.advanceTimersByTimeAsync(25); await ready; await immediate(); await settle(1100);
  };
  const tick = async () => { const ready = next(); await vi.advanceTimersByTimeAsync(1000); await ready; await immediate(); };
  return { directory, values, edit, tick };
}

it("retains incremental idle checks after a guarded native hint slice", async () => {
  const { directory, edit, tick } = await fixture();
  await edit();
  const listing = vi.spyOn(fs, "opendir");
  await tick(); // Confirm metadata captured inside the timestamp update window.
  expect(listing.mock.calls.map(([name]) => path.relative(directory, String(name)))).toEqual([path.join("tree", "a")]);
  listing.mockClear();
  await tick();
  expect(listing).not.toHaveBeenCalled();
}, 10_000);

it("does not mask unlisted child changes with timestamps observed by a parent slice", async () => {
  const { directory, values, edit, tick } = await fixture();
  const created = path.join("tree", "a", "nested", "created");
  await fs.writeFile(path.join(directory, created), "unhinted child");
  await edit();
  expect(values.flatMap(value => value.changes ?? []).map(change => change.path)).not.toContain(created);
  const listing = vi.spyOn(fs, "opendir");
  await tick();
  expect(values.flatMap(value => value.changes ?? []).map(change => change.path)).toContain(created);
  expect(listing.mock.calls.map(([name]) => path.relative(directory, String(name))).sort()).toEqual([
    path.join("tree", "a"), path.join("tree", "a", "nested"),
  ].sort());
}, 10_000);
