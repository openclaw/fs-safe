import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { createSuppressedError } from "../src/suppressed-error.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("asynchronous sidecar lock release failures", () => {
  it("creates a portable SuppressedError shape when the runtime has no constructor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SuppressedError");
    expect(Reflect.deleteProperty(globalThis, "SuppressedError")).toBe(true);
    try {
      const primary = new Error("primary");
      const suppressed = new Error("suppressed");
      expect(createSuppressedError(primary, suppressed, "combined")).toMatchObject({
        name: "SuppressedError",
        message: "combined",
        error: primary,
        suppressed,
      });
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "SuppressedError", descriptor);
    }
  });

  it("rejects when raw sidecar deletion fails", async () => {
    const directory = await tempRoot("fs-safe-lock-release-raw-");
    const targetPath = path.join(directory, "state.json");
    const manager = createSidecarLockManager(`release-raw-${Date.now()}-${Math.random()}`);
    const lock = await manager.acquire({ targetPath, payload: async () => ({}) });
    const failure = Object.assign(new Error("release deletion failed"), { code: "EIO" });
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(lock.lockPath)) throw failure;
      return await realRm(target, ...args);
    });

    await expect(lock.release()).rejects.toBe(failure);
    await expect(fs.access(lock.lockPath)).resolves.toBeUndefined();
    expect(manager.heldEntries()).toHaveLength(1);

    rm.mockRestore();
    await lock.release();
    await expect(fs.access(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });

  it("rejects when Root-backed sidecar deletion fails", async () => {
    const directory = await tempRoot("fs-safe-lock-release-root-");
    const targetPath = path.join(directory, "state.json");
    const capability = await root(directory);
    const manager = createSidecarLockManager(`release-root-${Date.now()}-${Math.random()}`);
    const lock = await manager.acquire({
      targetPath,
      lockRoot: capability,
      payload: async () => ({}),
    });
    const failure = Object.assign(new Error("root release failed"), { code: "EIO" });
    const remove = vi.spyOn(capability, "remove").mockRejectedValueOnce(failure);

    await expect(lock.release()).rejects.toBe(failure);
    await expect(fs.access(lock.lockPath)).resolves.toBeUndefined();
    const [entry] = manager.heldEntries();
    expect(entry).toBeDefined();

    remove.mockRestore();
    await entry?.forceRelease();
    await expect(fs.access(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });

  it("does not release a reentrant acquisition when retrying failed cleanup", async () => {
    const directory = await tempRoot("fs-safe-lock-release-reentrant-retry-");
    const targetPath = path.join(directory, "state.json");
    const manager = createSidecarLockManager(`release-reentrant-${Date.now()}-${Math.random()}`);
    const options = {
      targetPath,
      reentrantOwner: "owner",
      payload: async () => ({}),
    };
    const first = await manager.acquire(options);
    const second = await manager.acquire(options);
    await first.release();

    const failure = Object.assign(new Error("release deletion failed"), { code: "EIO" });
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementationOnce(async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(second.lockPath)) throw failure;
      return await realRm(target, ...args);
    });
    await expect(second.release()).rejects.toBe(failure);

    const third = await manager.acquire(options);
    await second.release();
    await expect(fs.access(third.lockPath)).resolves.toBeUndefined();
    expect(manager.heldEntries()).toHaveLength(1);

    rm.mockRestore();
    await third.release();
    await expect(fs.access(third.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });

  it("does not admit a reentrant acquisition while final cleanup is in flight", async () => {
    const directory = await tempRoot("fs-safe-lock-release-reentrant-in-flight-");
    const targetPath = path.join(directory, "state.json");
    const manager = createSidecarLockManager(`release-reentrant-in-flight-${Date.now()}-${Math.random()}`);
    const otherManager = createSidecarLockManager(
      `release-reentrant-in-flight-other-${Date.now()}-${Math.random()}`,
    );
    const options = {
      targetPath,
      reentrantOwner: "owner",
      payload: async () => ({}),
    };
    const first = await manager.acquire(options);
    const realRm = fs.rm.bind(fs);
    let cleanupStarted!: () => void;
    const cleanupInFlight = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let finishCleanup!: () => void;
    const allowCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(first.lockPath)) {
        cleanupStarted();
        await allowCleanup;
      }
      return await realRm(target, ...args);
    });

    const release = first.release();
    await cleanupInFlight;
    let reentrantAcquired = false;
    const secondPromise = manager.acquire(options).then((lock) => {
      reentrantAcquired = true;
      return lock;
    });
    await Promise.resolve();
    expect(reentrantAcquired).toBe(false);

    finishCleanup();
    await release;
    const second = await secondPromise;
    await expect(
      otherManager.acquire({
        targetPath,
        timeoutMs: 0,
        retry: { retries: 0 },
        payload: async () => ({}),
      }),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });

    rm.mockRestore();
    await second.release();
    expect(manager.heldEntries()).toEqual([]);
  });

  it("preserves callback and release failures from withFileLock", async () => {
    const directory = await tempRoot("fs-safe-lock-release-combined-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const bodyError = new Error("protected work failed");
    const releaseError = Object.assign(new Error("release cleanup failed"), { code: "EIO" });
    const realRm = fs.rm.bind(fs);
    let rm: ReturnType<typeof vi.spyOn> | undefined;

    const error = await withFileLock(
      targetPath,
      { managerKey: `release-combined-${Date.now()}-${Math.random()}`, payload: async () => ({}) },
      async () => {
        rm = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
          if (path.basename(String(target)) === path.basename(lockPath)) throw releaseError;
          return await realRm(target, ...args);
        });
        throw bodyError;
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "SuppressedError",
      error: releaseError,
      suppressed: bodyError,
    });
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    rm?.mockRestore();
    await fs.rm(lockPath, { force: true });
  });
});
