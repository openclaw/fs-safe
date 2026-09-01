import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLockSync, createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const posix = it.skipIf(process.platform === "win32");
afterEach(() => { vi.restoreAllMocks(); });

posix("non-Root async snapshot hands off after the owner unlinks its opened record", async () => {
  const directory = await fs.realpath(await tempRoot("sidecar-unlink-async-"));
  const target = path.join(directory, "state");
  const lockPath = `${target}.lock`;
  const ownerManager = createFileLockManager(`sibling-owner:${target}`);
  const waiterManager = createFileLockManager(`sibling-waiter:${target}`);
  const shouldReclaim = vi.fn(() => false);
  const owner = await ownerManager.acquire(target, { payload: () => ({ owner: "original" }) });
  const realOpen = fs.open.bind(fs);
  let opened: FileHandle | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === lockPath && !opened) {
      opened = handle;
      const before = await fs.lstat(lockPath, { bigint: true });
      const descriptor = await handle.stat({ bigint: true });
      expect([descriptor.dev, descriptor.ino]).toEqual([before.dev, before.ino]);
      await owner.release();
      expect(ownerManager.heldEntries()).toEqual([]);
      await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
    }
    return handle;
  });
  const waiter = await waiterManager.acquire(target, {
    payload: () => ({ owner: "waiter" }), shouldReclaim,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
  });
  try {
    expect(opened?.fd).toBe(-1);
    expect(shouldReclaim).not.toHaveBeenCalled();
    await expect(waiter.verifyStillHeld()).resolves.toBe(true);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ owner: "waiter" });
  } finally {
    await waiter.release();
    await owner.release();
    await ownerManager.drain();
    await waiterManager.drain();
  }
  await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

posix.each([false, true])("sync snapshot hands off an unlinked descriptor (lockRoot: %s)", async (bounded) => {
  const capability = await root(await tempRoot("sidecar-unlink-sync-"));
  const target = path.join(capability.rootReal, "state");
  const lockPath = `${target}.lock`;
  const options = { lockPath, ...(bounded ? { lockRoot: capability } : {}) };
  // Distinct logical targets sharing an explicit sidecar exercise filesystem
  // arbitration, rather than the sync manager's known-live-holder short circuit.
  const owner = acquireFileLockSync(`${target}.owner`, { ...options, payload: () => ({ owner: "original" }) });
  const shouldReclaim = vi.fn(() => false);
  let snapshotFd: number | undefined;
  let snapshotClosed = false;
  const realClose = fsSync.closeSync.bind(fsSync);
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    realClose(fd);
    if (fd === snapshotFd) snapshotClosed = true;
  });
  const realOpen = fsSync.openSync.bind(fsSync);
  vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
    const fd = realOpen(...args);
    if (String(args[0]) === lockPath && snapshotFd === undefined) {
      snapshotFd = fd;
      const before = fsSync.lstatSync(lockPath, { bigint: true });
      const descriptor = fsSync.fstatSync(fd, { bigint: true });
      expect([descriptor.dev, descriptor.ino]).toEqual([before.dev, before.ino]);
      owner.release();
      expect(() => fsSync.lstatSync(lockPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(fsSync.fstatSync(fd, { bigint: true }).nlink).toBe(0n);
    }
    return fd;
  });
  const waiter = acquireFileLockSync(target, {
    ...options, payload: () => ({ owner: "waiter" }), shouldReclaim,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
  });
  try {
    expect(snapshotFd).toBeDefined();
    expect(snapshotClosed).toBe(true);
    expect(shouldReclaim).not.toHaveBeenCalled();
    expect(waiter.verifyStillHeld()).toBe(true);
    expect(JSON.parse(fsSync.readFileSync(lockPath, "utf8"))).toEqual({ owner: "waiter" });
  } finally {
    waiter.release();
    owner.release();
  }
  expect(() => fsSync.lstatSync(lockPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
});
