import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinDirectory, pinnedDirectoryProcPath, type PinnedDirectory } from "../src/directory-durability.js";
import { nativeWatchSupported } from "../src/watch-node.js";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";

let dir: string;
let pin: PinnedDirectory | undefined;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-dir-pin-")); pin = undefined; });
afterEach(async () => { vi.restoreAllMocks(); await pin?.close(); await fs.rm(dir, { recursive: true, force: true }); });

it.skipIf(process.platform !== "linux")("does not derive descriptor authority from mutable public receipts or replacement paths", async () => {
  const target = path.join(dir, "target");
  const outside = path.join(dir, "outside");
  const saved = path.join(dir, "saved");
  await fs.mkdir(target); await fs.mkdir(outside);
  const original = await fs.stat(target, { bigint: true });
  pin = await pinDirectory(target);
  const proc = await pinnedDirectoryProcPath(pin);
  await fs.rename(target, saved); await fs.symlink(outside, target, "dir");
  pin.receipt.path = outside; pin.receipt.realPath = outside;
  pin.receipt.identity = await fs.stat(outside);
  expect(await pinnedDirectoryProcPath(pin)).toBe(proc);
  const pinned = await fs.stat(proc, { bigint: true });
  expect([pinned.dev, pinned.ino]).toEqual([original.dev, original.ino]);
  await expect(pin.assertCurrent()).rejects.toMatchObject({ code: "not-file" });
  await expect(pinnedDirectoryProcPath({ ...pin } as PinnedDirectory)).rejects.toMatchObject({ code: "path-mismatch" });
  await fs.unlink(target); await fs.rename(saved, target);
  await pin.close();
  await expect(pinnedDirectoryProcPath(pin)).rejects.toMatchObject({ code: "path-mismatch" });
});

it.skipIf(!nativeWatchSupported)("fails observation closed when procfs authority is unverified without path fallback", async () => {
  const admitted = await root(dir);
  const statfs = fs.statfs;
  vi.spyOn(fs, "statfs").mockImplementation(async (name, options) => {
    if (String(name) === "/proc/self/fd") return { type: 0x1234n } as Awaited<ReturnType<typeof fs.statfs>>;
    return await statfs(name, options);
  });
  let hints = 0;
  const owner = watch(admitted, { scopes: [{ path: "", kind: "tree" }], onDirty() { hints++; } });
  try {
    await expect(owner.ready).rejects.toMatchObject({ code: "helper-unavailable", details: { operation: "watch" } });
    await expect(owner.close()).resolves.toBeUndefined();
    expect(owner.health()).toMatchObject({ state: "closed", workers: 0, directories: 0, failure: { operation: "watch" } });
    expect(hints).toBe(0);
  } finally { await owner.close(); }
});


it.skipIf(!nativeWatchSupported)("does not erase a pin cleanup failure after successful native retirement", async () => {
  const admitted = await root(dir);
  const cleanupError = new Error("pin close reported failure");
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); throw cleanupError; });
    return handle;
  });
  const owner = watch(admitted, { scopes: [{ path: "", kind: "tree" }], onDirty() {} });
  try {
    await owner.ready;
    const closing = owner.close();
    await expect(closing).rejects.toBe(cleanupError);
    expect(owner.close()).toBe(closing);
    expect(owner.health()).toMatchObject({ state: "closed", workers: 0, error: cleanupError, failure: { operation: "close" } });
    await expect(owner.update([{ path: "", kind: "tree" }])).rejects.toMatchObject({ name: "AbortError" });
  } finally { await owner.close().catch(() => {}); }
});
