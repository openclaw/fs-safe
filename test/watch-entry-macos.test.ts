import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchSubscription, type WatchInvalidation } from "../src/watch.js";
import { getNativeBinding } from "../src/native.js";
import { watchBinding } from "../src/watch-native.js";

const mac = it.skipIf(process.platform !== "darwin" || !watchBinding("auto"));
let owner: WatchSubscription | undefined;
let directory: string | undefined;
afterEach(async () => {
  await owner?.close(); owner = undefined;
  vi.restoreAllMocks();
  if (directory) await fs.rm(directory, { recursive: true, force: true }); directory = undefined;
});
async function fixture() {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-entry-macos-")));
  return directory;
}
mac("keeps entry anchors out of the recursive stream in mixed subscriptions", async () => {
  const dir = await fixture();
  await fs.mkdir(path.join(dir, "tree"));
  await fs.writeFile(path.join(dir, "entry"), "selected");
  const configure = vi.spyOn(getNativeBinding()!, "watchConfigure");
  owner = watch(await root(dir), { mode: "events", scopes: [{ path: "entry", kind: "entry" }, { path: "tree", kind: "tree", depth: 0 }], onInvalidate() {} });
  await owner.ready; await owner.reconcile();
  // Depth-zero trees keep their existing FSEvents parent anchor semantics.
  expect(configure.mock.calls.at(-1)?.[1]).toEqual([dir]);
  await owner.setScopes([{ path: "entry", kind: "entry" }, { path: "tree", kind: "tree", depth: 1 }]);
  await owner.reconcile();
  expect(configure.mock.calls.at(-1)?.[1]).toEqual([path.join(dir, "tree")]);
  configure.mockClear();
  await owner.setScopes([{ path: "entry", kind: "entry" }]); await owner.reconcile();
  expect(configure).not.toHaveBeenCalled();
  expect(owner.health().directories).toBe(2);
});
mac("re-arms missing nested entries and excludes child-only changes to directory entries", async () => {
  const dir = await fixture();
  const hints: WatchInvalidation[] = [];
  owner = watch(await root(dir), { mode: "events", intervalMs: 60_000, scopes: [{ path: "parent/entry", kind: "entry" }], onInvalidate: hint => { hints.push(hint); } });
  await owner.ready; await owner.reconcile();
  expect(owner.health().directories).toBe(1);
  await fs.mkdir(path.join(dir, "parent/entry"), { recursive: true });
  await vi.waitFor(() => expect(hints.some(hint => hint.changes?.some(change => change.path === "parent/entry"))).toBe(true), { timeout: 5000 });
  await owner.reconcile();
  expect(owner.health().directories).toBe(2);
  hints.length = 0;
  await fs.writeFile(path.join(dir, "parent/entry/child"), "not selected");
  await owner.reconcile(); await new Promise(resolve => setTimeout(resolve, 100));
  expect(hints).toEqual([]);
});
mac("fails descriptor exhaustion without silently dropping coverage", async () => {
  const dir = await fixture();
  vi.spyOn(getNativeBinding()!, "watchEntries").mockImplementation(() => { throw Object.assign(new Error("open kqueue descriptor: too many open files"), { code: "EMFILE" }); });
  owner = watch(await root(dir), { mode: "auto", scopes: [{ path: "entry", kind: "entry" }], onInvalidate() {} });
  await expect(owner.ready).rejects.toMatchObject({ code: "helper-failed", details: { code: "EMFILE" } });
  expect(owner.health()).toMatchObject({ mode: "events", state: "unavailable" });
});
