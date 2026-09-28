import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchSubscription } from "../src/watch.js";
import { getNativeBinding } from "../src/native.js";
import { watchBinding } from "../src/watch-native.js";
import { watchScopes, type WatchSnapshot } from "../src/watch-scan.js";
import { watchStreamPaths } from "../src/watch-stream.js";
import { __setFsSafeTestHooksForTest as hooks } from "../src/test-hooks.js";

const canonical = (name: string) => path.resolve("synthetic-root", name);
const snapshot = (): WatchSnapshot => ({ entries: new Map(), targets: new Map(), directories: new Map(), scanned: 0,
  directoryPaths: new Map(["", "selected", "selected/deep", "other"].map(name => [name, canonical(name)])),
  excludedDirectories: new Map(),
});
it("deduplicates tree anchors and missing-target ancestors without entry parents", () => {
  const result = watchStreamPaths(snapshot(), watchScopes([
    { path: "selected/file", kind: "entry" }, { path: "selected", kind: "tree" },
    { path: "selected/deep", kind: "tree" }, { path: "other/missing/deep", kind: "tree" },
  ]));
  expect(new Set(result.anchors)).toEqual(new Set([canonical("selected"), canonical("other")]));
  expect(watchStreamPaths(snapshot(), watchScopes([{ path: "", kind: "tree" }])).anchors).toEqual([canonical("")]);
  expect(watchStreamPaths(snapshot(), watchScopes([{ path: "other/file", kind: "entry" }])).anchors).toEqual([]);
});
it("chooses no more than eight shallow non-overlapping exclusions", () => {
  const value = snapshot();
  value.excludedDirectories = new Map([
    ["nested", canonical("excluded-0/deep")],
    ...Array.from({ length: 10 }, (_, n) => [`excluded-${n}`, canonical(`excluded-${n}`)] as [string, string]),
  ]);
  expect(watchStreamPaths(value, watchScopes([{ path: "", kind: "tree" }])).exclusions).toEqual(
    Array.from({ length: 8 }, (_, n) => canonical(`excluded-${n}`)),
  );
});

let owner: WatchSubscription | undefined;
let directory: string | undefined;
afterEach(async () => { hooks(); await owner?.close(); owner = undefined; vi.restoreAllMocks(); if (directory) await fs.rm(directory, { recursive: true, force: true }); directory = undefined; });
it.skipIf(process.platform !== "darwin" || !watchBinding("auto"))("restarts changed exclusions before a following guarded pass and narrows selected anchors", async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-stream-")));
  const selected = path.join(directory, "selected");
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, "file"), "value");
  const binding = getNativeBinding()!;
  const configure = vi.spyOn(binding, "watchConfigure");
  owner = watch(await root(directory), { mode: "events", scopes: [{ path: "selected", kind: "tree" }],
    exclude: entry => entry.kind === "directory" && entry.path.endsWith("dist"), onInvalidate() {},
  });
  await owner.ready; await owner.reconcile();
  expect(configure.mock.calls.at(-1)?.slice(1)).toEqual([[selected], []]);
  const dist = path.join(selected, "dist");
  await fs.mkdir(dist);
  let configuredPass = false;
  const count = configure.mock.calls.length;
  hooks({ beforeWatchRegistration: () => {
    if (configure.mock.calls.length > count) configuredPass = true;
  } });
  await owner.reconcile(); await owner.reconcile();
  expect(configure.mock.calls.at(-1)?.slice(1)).toEqual([[selected], [dist]]);
  expect(configuredPass).toBe(true);
  await fs.rm(dist, { recursive: true });
  await fs.writeFile(dist, "now a selected file");
  await owner.reconcile();
  expect(configure.mock.calls.at(-1)?.slice(1)).toEqual([[selected], []]);
});

it.skipIf(process.platform !== "darwin" || !watchBinding("auto")).each([false, true])("keeps empty event scopes idle without configuring an empty stream (replacement: %s)", async replacement => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-empty-stream-")));
  const binding = getNativeBinding()!;
  const configure = vi.spyOn(binding, "watchConfigure");
  owner = watch(await root(directory), { mode: "events", scopes: replacement ? [{ path: "", kind: "tree" }] : [], onInvalidate() {} });
  await owner.ready;
  if (replacement) await owner.setScopes([]);
  configure.mockClear();
  await owner.reconcile();
  expect(owner.health()).toMatchObject({ mode: "events", state: "ready", directories: 0 });
  expect(configure).not.toHaveBeenCalled();
  expect(binding.watchThreadCount!()).toBe(0);
});
