import fsSync, { Dir } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchSubscription } from "../src/watch.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const nodeRuntime = !process.versions.bun && !process.versions.deno;
let owner: WatchSubscription | undefined;
afterEach(async () => { vi.restoreAllMocks(); await owner?.close(); owner = undefined; });

it.skipIf(!nodeRuntime).each(["bun", "deno"])("retains asynchronous enumeration for %s compatibility", async runtime => {
  const directory = await tempRoot("watch-async-runtime-");
  await fs.writeFile(path.join(directory, "entry"), "value");
  const capability = await root(directory);
  const original = Object.getOwnPropertyDescriptor(process.versions, runtime);
  Object.defineProperty(process.versions, runtime, { configurable: true, value: "fixture" });
  try {
    const reads = vi.spyOn(Dir.prototype, "readSync").mockImplementation(() => { throw new Error("unbounded synchronous enumeration"); });
    const asynchronousReads = vi.spyOn(Dir.prototype, "read");
    owner = watch(capability, { mode: "poll", scopes: [{ path: "", kind: "tree" }], onInvalidate() {} });
    await owner.ready;
    expect(reads).not.toHaveBeenCalled();
    expect(asynchronousReads).toHaveBeenCalled();
    await owner.close();
  } finally {
    if (original) Object.defineProperty(process.versions, runtime, original);
    else delete process.versions[runtime];
  }
});

it.skipIf(!nodeRuntime)("keeps one-entry budget lookahead and never stats the rejected leaf", async () => {
  const directory = await tempRoot("watch-sync-budget-");
  await fs.writeFile(path.join(directory, "first"), "one");
  await fs.writeFile(path.join(directory, "second"), "two");
  const reads = vi.spyOn(Dir.prototype, "readSync");
  const asynchronousReads = vi.spyOn(Dir.prototype, "read");
  const metadata = vi.spyOn(fsSync, "lstatSync");
  owner = watch(await root(directory), { mode: "poll", scopes: [{ path: "", kind: "tree" }], maxEntries: 1, onInvalidate() {} });
  await expect(owner.ready).rejects.toMatchObject({ code: "too-large" });
  expect(reads).toHaveBeenCalledTimes(2);
  expect(asynchronousReads).not.toHaveBeenCalled();
  expect(metadata.mock.calls.filter(([name]) => path.dirname(String(name)) === directory)).toHaveLength(1);
});

it.skipIf(!nodeRuntime)("yields to abort a wide scan before exhausting its directory", async () => {
  const directory = await tempRoot("watch-sync-abort-");
  for (let n = 0; n < 128; n++) await fs.writeFile(path.join(directory, `file-${n}`), "value");
  const controller = new AbortController();
  const read = Dir.prototype.readSync;
  let reads = 0, scheduled = false;
  vi.spyOn(Dir.prototype, "readSync").mockImplementation(function (this: Dir) {
    reads++;
    if (!scheduled) { scheduled = true; setImmediate(() => controller.abort()); }
    return read.call(this);
  });
  owner = watch(await root(directory), { mode: "poll", scopes: [{ path: "", kind: "tree" }], signal: controller.signal, onInvalidate() {} });
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(32);
  await owner.close();
  expect(owner.health()).toMatchObject({ state: "closed", directories: 0 });
});

it.skipIf(!nodeRuntime || process.platform === "win32")("revalidates after a synchronous name read before inspecting its leaf", async () => {
  const directory = await tempRoot("watch-sync-race-");
  const outside = await tempRoot("watch-sync-outside-");
  const child = path.join(directory, "child"), leaf = path.join(child, "entry");
  await fs.mkdir(child);
  await fs.writeFile(leaf, "inside");
  await fs.writeFile(path.join(outside, "entry"), "outside sentinel");
  const read = Dir.prototype.readSync;
  let swapped = false;
  vi.spyOn(Dir.prototype, "readSync").mockImplementation(function (this: Dir) {
    const entry = read.call(this);
    if (!swapped && this.path === child && entry !== null) {
      swapped = true;
      fsSync.renameSync(child, path.join(directory, "retired"));
      fsSync.symlinkSync(outside, child, "dir");
    }
    return entry;
  });
  const metadata = vi.spyOn(fsSync, "lstatSync");
  owner = watch(await root(directory), { mode: "poll", scopes: [{ path: "child", kind: "tree" }], onInvalidate() {} });
  await owner.ready;
  expect(swapped).toBe(true);
  expect(metadata.mock.calls.filter(([name]) => String(name) === leaf)).toHaveLength(0);
  expect(await fs.readFile(path.join(outside, "entry"), "utf8")).toBe("outside sentinel");
  expect(owner.health().failure).toBeUndefined();
});
