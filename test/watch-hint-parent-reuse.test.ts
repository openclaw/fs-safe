import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { rootHandleContext } from "../src/root-handle-context.js";
import { admittedNativeChanges } from "../src/watch-hints.js";
import * as io from "../src/watch-io.js";
import { scanWatch, watchScopes } from "../src/watch-scan.js";
import * as native from "../src/watch-native.js";
import type { NativeBinding } from "../src/native.js";
import { __setFsSafeTestHooksForTest as hooks } from "../src/test-hooks.js";
import { watch, type WatchInvalidation } from "../src/watch.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { hooks(); vi.restoreAllMocks(); });
async function fixture() {
  const directory = await tempRoot("watch-parent-reuse-");
  await fs.mkdir(path.join(directory, "selected"));
  await fs.mkdir(path.join(directory, "noise"));
  await fs.writeFile(path.join(directory, "selected", "config"), "selected");
  const context = rootHandleContext(await root(directory));
  const scopes = watchScopes([{ path: path.join("selected", "config"), kind: "entry" }]);
  const controller = new AbortController();
  const snapshot = await scanWatch(context, scopes, {
    maxEntries: 100, maxDirectories: 100, maxPendingPaths: 256, admitting: true,
  }, controller.signal, async () => {});
  const admit = (names: string[], parent = "noise") => admittedNativeChanges(context, scopes, snapshot, snapshot, {
    hints: names.map(name => ({ directory: parent, name, event: "rename" as const })), overflow: false,
  }, controller.signal, 256);
  return { directory, controller, admit };
}

it.each([1, 16, 128])("shares acquisition but revalidates every unrelated parent hint (%s)", async count => {
  const { directory, admit } = await fixture();
  const capture = vi.spyOn(io, "watchGuard");
  const assert = vi.spyOn(io, "watchAssert");
  const metadata = vi.spyOn(syncFs, "lstatSync"), realpath = vi.spyOn(syncFs.realpathSync, "native");
  await expect(admit(Array.from({ length: count }, (_, index) => "gone-" + index))).resolves.toEqual([]);
  expect(capture.mock.calls.filter(([, name]) => name === path.join(directory, "noise"))).toHaveLength(1);
  expect(assert.mock.calls.filter(([, guard]) => guard.dir === path.join(directory, "noise"))).toHaveLength(count);
  // Actual filesystem work still includes a fresh physical-path/identity fence
  // for every reuse. This is an internal regression, not a public call budget.
  expect(metadata.mock.calls.length + realpath.mock.calls.length).toBeLessThan(8 * count + 4);
});

it("does not reuse parent admission across calls", async () => {
  const { directory, admit } = await fixture();
  const capture = vi.spyOn(io, "watchGuard");
  await expect(admit(["one", "two"])).resolves.toEqual([]);
  await expect(admit(["three", "four"])).resolves.toEqual([]);
  expect(capture.mock.calls.filter(([, name]) => name === path.join(directory, "noise"))).toHaveLength(2);
});

it.each(["removed", "selected-alias"])("freshly admits a reused parent after it becomes %s", async operation => {
  const { directory, admit } = await fixture();
  const noise = path.join(directory, "noise");
  const resolve = io.watchResolve, assert = io.watchAssert;
  let changed = false;
  // Model ordinary filesystem spelling alias resolution on case-sensitive CI;
  // the original guards and exact identities still come from real directories.
  vi.spyOn(io, "watchResolve").mockImplementation((context, name, options) =>
    resolve(context, changed && operation === "selected-alias" && name === "./noise" ? "./selected" : name, options));
  vi.spyOn(io, "watchAssert").mockImplementation(async (context, guard) => {
    await assert(context, guard);
    if (guard.dir === noise && !changed) {
      changed = true;
      await fs.rm(noise, { recursive: true });
    }
  });
  await expect(admit(["unrelated", "config"])).resolves.toEqual(operation === "removed" ? [] : [
    { path: path.join("selected", "config"), type: "structural" },
  ]);
  expect(changed).toBe(true);
});

it("re-resolves a parent spelling alias even while its former referent survives", async () => {
  const { directory, admit } = await fixture();
  const resolve = io.watchResolve, assert = io.watchAssert;
  let redirected = false;
  vi.spyOn(io, "watchResolve").mockImplementation((context, name, options) =>
    resolve(context, name === "./alias" ? redirected ? "./selected" : "./noise" : name, options));
  vi.spyOn(io, "watchAssert").mockImplementation(async (context, guard) => {
    await assert(context, guard);
    if (guard.dir === path.join(directory, "noise")) redirected = true;
  });
  // Validating the former canonical directory cannot validate a redirected
  // filesystem spelling alias. Both physical identities remain real.
  await expect(admit(["unrelated", "config"], "alias")).resolves.toEqual([
    { path: path.join("selected", "config"), type: "structural" },
  ]);
});

it("rejects a junction redirect during parent reuse without looking up outside names", async () => {
  const { directory, admit } = await fixture();
  const outside = await tempRoot("watch-parent-reuse-outside-");
  await fs.writeFile(path.join(outside, "OUTSIDE_SENTINEL"), "private");
  const noise = path.join(directory, "noise"), assert = io.watchAssert;
  let swapped = false;
  vi.spyOn(io, "watchAssert").mockImplementation(async (context, guard) => {
    await assert(context, guard);
    if (!swapped && guard.dir === noise) {
      swapped = true;
      await fs.rm(noise, { recursive: true });
      await fs.symlink(outside, noise, process.platform === "win32" ? "junction" : "dir");
    }
  });
  const lookup = vi.spyOn(io, "watchLookup");
  await expect(admit(["one", "OUTSIDE_SENTINEL"])).resolves.toEqual([]);
  expect(swapped).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
});

it("retains full rename scans and independent peer/scope retirement", async () => {
  const { directory } = await fixture();
  const callbacks: ((batch: native.NativeWatchBatch) => void)[] = [];
  vi.spyOn(native, "watchBinding").mockReturnValue({ watchRegister: () => 1, watchAdd() {}, watchUnregister() {},
    watchConfigure() {}, watchEntries: () => ({ changed: false, directories: 0 }),
  } as unknown as NativeBinding);
  hooks({ afterWatchBackendCreated: (_, callback) => { callbacks.push(callback); } });
  const values: WatchInvalidation[] = [];
  let scans = 0, ready = 0;
  const capability = await root(directory), controller = new AbortController();
  const options = { mode: "events" as const, scopes: [{ path: path.join("selected", "config"), kind: "entry" as const }],
    intervalMs: 60_000, onInvalidate(value: WatchInvalidation) { values.push(value); },
    onHealth(value: { state: string }) { if (value.state === "reconciling") scans++; if (value.state === "ready") ready++; },
  };
  const first = watch(capability, { ...options, signal: controller.signal }), peer = watch(capability, options);
  try {
    await Promise.all([first.ready, peer.ready]);
    values.length = 0; scans = 0; ready = 0;
    const capture = vi.spyOn(io, "watchGuard");
    const batch: native.NativeWatchBatch = { overflow: false, hints: Array.from({ length: 128 }, (_, index) =>
      ({ directory: "noise", name: "gone-" + index, event: "rename" as const })) };
    callbacks[0]!(batch); callbacks[1]!(batch);
    await expect.poll(() => ready).toBe(2);
    expect(scans).toBe(2); // Partial mitigation: namespace uncertainty still scans both owners.
    expect(values).toEqual([]);
    expect(capture.mock.calls.filter(([, name]) => name === path.join(directory, "noise"))).toHaveLength(2);
    controller.abort(); await first.close();
    capture.mockClear();
    await fs.writeFile(path.join(directory, "selected", "config"), "peer still observes selected changes");
    callbacks[0]!(batch); callbacks[1]!({ overflow: false, hints: [{ directory: "selected", name: "config", event: "rename" }] });
    await expect.poll(() => values.flatMap(value => value.changes ?? [])).toContainEqual({ path: path.join("selected", "config"), type: "structural" });
    expect(first.health().state).toBe("closed");
    expect(peer.health().failure).toBeUndefined();
    expect(capture.mock.calls.filter(([, name]) => name === path.join(directory, "noise"))).toHaveLength(0);
    await peer.setScopes([{ path: "missing", kind: "tree" }]);
    values.length = 0; capture.mockClear();
    callbacks[1]!(batch); // Retired backend callback cannot enter the replacement generation.
    await peer.reconcile();
    expect(values).toEqual([]);
    expect(capture.mock.calls.filter(([, name]) => name === path.join(directory, "noise"))).toHaveLength(0);
  } finally { await Promise.all([first.close(), peer.close()]); }
});

it("does not let revalidation suppress cancellation", async () => {
  const { directory, controller, admit } = await fixture();
  const assert = io.watchAssert;
  let checks = 0;
  vi.spyOn(io, "watchAssert").mockImplementation(async (context, guard) => {
    await assert(context, guard);
    if (guard.dir === path.join(directory, "noise") && ++checks === 2) controller.abort();
  });
  await expect(admit(["one", "two"])).rejects.toMatchObject({ name: "AbortError" });
});
