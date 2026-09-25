import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchDirty, type WatchSubscription } from "../src/watch.js";
import { nativeWatchSupported, type NodeWatchBatch } from "../src/watch-node.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

let dir: string;
let owner: WatchSubscription | undefined;
beforeEach(async () => { dir = (await root(await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-pin-")))).rootReal; owner = undefined; });
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  await owner?.close().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
});
async function pins() {
  const links = await Promise.all((await fs.readdir("/proc/self/fd")).map(fd => fs.readlink("/proc/self/fd/" + fd).catch(() => "")));
  return links.filter(name => name === dir || name.startsWith(dir + path.sep)).length;
}

it.skipIf(!nativeWatchSupported).each(["root", "descendant"])("pins %s identity before a swap without outside activity publication", async target => {
  const authority = path.join(dir, "authority");
  const watched = path.join(authority, "tree");
  const outside = path.join(dir, "outside");
  const saved = path.join(dir, "saved");
  await fs.mkdir(watched, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(watched, "shared-name"), "inside");
  await fs.writeFile(path.join(outside, "shared-name"), "outside");
  const beforePins = await pins();
  const targetPath = target === "root" ? authority : watched;
  let swapped = false;
  let restored = false;
  __setFsSafeTestHooksForTest({
    beforeWatchRegistration: async name => {
      if (name !== targetPath || swapped) return;
      swapped = true;
      await fs.rename(targetPath, saved);
      await fs.symlink(outside, targetPath, "dir");
    },
    afterWatchRegistration: async name => {
      if (name !== targetPath || restored) return;
      restored = true;
      await fs.unlink(targetPath);
      await fs.rename(saved, targetPath);
    },
  });
  const raw: NodeWatchBatch[] = [];
  const emit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, "emit").mockImplementation(function (this: Worker, event, ...args) {
    const message = args[0] as { type?: string } | undefined;
    if (event === "message" && message?.type === "dirty") raw.push(message as NodeWatchBatch);
    return emit.call(this, event, ...args);
  });
  const hints: WatchDirty[] = [];
  const admitted = await root(authority);
  owner = watch(admitted, { scopes: [{ path: "tree", kind: "tree" }], onDirty: hint => { hints.push(hint); } });
  await owner.ready;
  expect([swapped, restored]).toEqual([true, true]);
  expect(await pins()).toBeGreaterThan(beforePins);
  raw.length = 0; hints.length = 0;
  await fs.writeFile(path.join(watched, "shared-name"), "allowed");
  // Positive native signal comes first, with the ordinary unchanged deadline.
  await expect.poll(() => raw.some(batch => batch.hints.some(hint => hint.directory === "tree" && hint.name === "shared-name"))).toBe(true);
  await expect.poll(() => hints.length).toBeGreaterThan(0);
  await expect(admitted.readText("tree/shared-name")).resolves.toBe("allowed");
  await owner.reconcile();
  // Settle already-generated setup/positive callbacks before a bounded negative
  // activity window. This is not a delay that makes positive readiness pass.
  await new Promise(resolve => setTimeout(resolve, 100));
  raw.length = 0; hints.length = 0;
  await fs.writeFile(path.join(outside, "shared-name"), "forbidden matched-name activity");
  await fs.writeFile(path.join(outside, "outside-only"), "forbidden unknown-name activity");
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(raw).toEqual([]);
  expect(hints).toEqual([]);
  await owner.close();
  expect(await pins()).toBe(beforePins);
});

it.skipIf(!nativeWatchSupported)("retains descriptor pins until the worker retirement promise is joined", async () => {
  const before = await pins();
  owner = watch(await root(dir), { scopes: [{ path: "", kind: "tree" }], onDirty() {} });
  await owner.ready;
  expect(await pins()).toBeGreaterThan(before);
  let entered!: () => void;
  let release!: () => void;
  const joining = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminate = Worker.prototype.terminate;
  vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function (this: Worker) {
    const code = await terminate.call(this);
    entered();
    await gate;
    return code;
  });
  const closing = owner.close();
  await joining;
  try { expect(await pins()).toBeGreaterThan(before); }
  finally { release(); }
  await closing;
  expect(await pins()).toBe(before);
});
