import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager, withSidecarLock } from "../src/sidecar-lock.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

describe("asynchronous sidecar lock acquisition failures", () => {
  it("removes a partially-written lock when payload persistence fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-write-failure-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const realOpen = fs.open.bind(fs);
    const failure = Object.assign(new Error("lock write failed"), { code: "EIO" });
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
      return handle;
    });

    const manager = createSidecarLockManager(`write-failure-${Date.now()}-${Math.random()}`);
    await expect(manager.acquire({ targetPath, payload: async () => ({ owner: "one" }) }))
      .rejects.toBe(failure);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });

  it("preserves a replacement lock when payload persistence fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-write-failure-swap-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const displacedPath = `${lockPath}.displaced`;
    const realOpen = fs.open.bind(fs);
    const failure = Object.assign(new Error("lock write failed"), { code: "EIO" });
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await fs.rename(lockPath, displacedPath);
        await fs.writeFile(lockPath, "replacement");
        throw failure;
      });
      return handle;
    });

    const manager = createSidecarLockManager(
      `write-failure-swap-${Date.now()}-${Math.random()}`,
    );
    await expect(manager.acquire({ targetPath, payload: async () => ({ owner: "one" }) }))
      .rejects.toBe(failure);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("replacement");
    expect(manager.heldEntries()).toEqual([]);
  });

  it("falls back to a resolved target when parent realpath lookup fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-realpath-failure-");
    const targetPath = path.join(directory, "state.json");
    vi.spyOn(fs, "realpath").mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "EIO" }));
    const manager = createSidecarLockManager(`realpath-failure-${Date.now()}-${Math.random()}`);
    const lock = await manager.acquire({ targetPath, payload: async () => ({ owner: "one" }) });
    expect(lock.normalizedTargetPath).toBe(path.resolve(targetPath));
    await lock.release();
  });

  it("maps a lockRoot create collision to contention without weakening confinement", async () => {
    const directory = await tempRoot("fs-safe-sidecar-root-collision-");
    const lockDirectory = path.join(directory, "locks");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const targetPath = path.join(directory, "state.json");
    const lockPath = path.join(lockDirectory, "state.lock");
    const firstManager = createSidecarLockManager(`root-first-${Date.now()}-${Math.random()}`);
    const secondManager = createSidecarLockManager(`root-second-${Date.now()}-${Math.random()}`);
    const first = await firstManager.acquire({
      targetPath,
      lockPath,
      lockRoot,
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "first" }),
    });
    await expect(secondManager.acquire({
      targetPath,
      lockPath,
      lockRoot,
      timeoutMs: 0,
      retry: { retries: 0 },
      payload: async () => ({ owner: "second" }),
    })).rejects.toMatchObject({ code: "file_lock_timeout" });
    await first.release();
  });

  it("removes a lockRoot sidecar if opening the created lock fails", async () => {
    const directory = await tempRoot("fs-safe-sidecar-root-open-failure-");
    const lockDirectory = path.join(directory, "locks");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const targetPath = path.join(directory, "state.json");
    const lockPath = path.join(lockDirectory, "state.lock");
    const failure = Object.assign(new Error("lock open failed"), { code: "EIO" });
    vi.spyOn(lockRoot, "open").mockRejectedValueOnce(failure);

    const manager = createSidecarLockManager(`root-open-failure-${Date.now()}-${Math.random()}`);
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        lockRoot,
        payload: async () => ({ owner: "one" }),
      }),
    ).rejects.toBe(failure);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });

  it("preserves a replacement lockRoot sidecar if opening the created lock fails", async () => {
    const directory = await tempRoot("fs-safe-sidecar-root-open-failure-swap-");
    const lockDirectory = path.join(directory, "locks");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const targetPath = path.join(directory, "state.json");
    const lockPath = path.join(lockDirectory, "state.lock");
    const displacedPath = path.join(lockDirectory, "state.displaced");
    const failure = Object.assign(new Error("lock open failed"), { code: "EIO" });
    vi.spyOn(lockRoot, "open").mockImplementationOnce(async () => {
      await fs.rename(lockPath, displacedPath);
      await fs.writeFile(lockPath, "replacement");
      throw failure;
    });

    const manager = createSidecarLockManager(
      `root-open-failure-swap-${Date.now()}-${Math.random()}`,
    );
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        lockRoot,
        payload: async () => ({ owner: "one" }),
      }),
    ).rejects.toBe(failure);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("replacement");
    expect(manager.heldEntries()).toEqual([]);
  });

  it("releases a newly-created lock if reclaim-guard cleanup cannot complete", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-guard-release-failure-");
    const targetPath = path.join(await fs.realpath(directory), "state.json");
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.reclaim`;
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));
    const realRmdir = fs.rmdir.bind(fs);
    vi.spyOn(fs, "rmdir").mockImplementation(async (pathname, options) => {
      if (String(pathname) === guardPath) {
        throw Object.assign(new Error("guard cleanup denied"), { code: "EACCES" });
      }
      return await realRmdir(pathname, options);
    });

    const manager = createSidecarLockManager(`guard-release-${Date.now()}-${Math.random()}`);
    await expect(manager.acquire({
      targetPath,
      staleMs: 1,
      staleRecovery: "remove-if-unchanged",
      payload: async () => ({ createdAt: new Date().toISOString() }),
      shouldReclaim: async () => true,
      shouldRemoveStaleLock: async () => true,
    })).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(guardPath)).isDirectory()).toBe(true);
    expect(manager.heldEntries()).toEqual([]);
  });

  it("releases withSidecarLock after callback failure and exposes force-release entries", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-lifecycle-");
    const targetPath = path.join(directory, "state.json");
    await expect(withSidecarLock(
      targetPath,
      { managerKey: `with-lock-${Date.now()}-${Math.random()}`, payload: async () => ({}) },
      async () => {
        throw new Error("callback failed");
      },
    )).rejects.toThrow("callback failed");
    await expect(fs.access(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    const manager = createSidecarLockManager(`lifecycle-${Date.now()}-${Math.random()}`);
    await manager.acquire({ targetPath, metadata: { purpose: "test" }, payload: async () => ({}) });
    const [entry] = manager.heldEntries();
    expect(entry?.metadata).toEqual({ purpose: "test" });
    await entry?.forceRelease();
    expect(manager.heldEntries()).toEqual([]);
    await manager.drain();
    manager.reset();
  });

  it("clears a compromise timer when its lock is released normally", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-timer-release-");
    const manager = createSidecarLockManager(`timer-release-${Date.now()}-${Math.random()}`);
    const compromised = vi.fn();
    const lock = await manager.acquire({
      targetPath: path.join(directory, "state.json"),
      payload: async () => ({}),
      compromiseCheckIntervalMs: 60_000,
      onCompromised: compromised,
    });
    await lock.release();
    expect(compromised).not.toHaveBeenCalled();
  });

  it("treats a rejected compromise check as a lost lock instead of an unhandled rejection", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-timer-reject-");
    const manager = createSidecarLockManager(`timer-reject-${Date.now()}-${Math.random()}`);
    const compromised = vi.fn();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const lock = await manager.acquire({
        targetPath: path.join(directory, "state.json"),
        payload: async () => ({}),
        compromiseCheckIntervalMs: 10,
        onCompromised: compromised,
      });
      const failure = Object.assign(new Error("lock snapshot failed"), { code: "EIO" });
      __setFsSafeTestHooksForTest({
        beforeSidecarLockSnapshotOpen: async () => {
          throw failure;
        },
      });
      await vi.waitFor(() => {
        expect(compromised).toHaveBeenCalledTimes(1);
      });
      expect(compromised).toHaveBeenCalledWith({
        lockPath: lock.lockPath,
        normalizedTargetPath: lock.normalizedTargetPath,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      expect(compromised).toHaveBeenCalledTimes(1);
      expect(rejections).toEqual([]);
      __setFsSafeTestHooksForTest(undefined);
      await lock.release();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reset fails closed across malformed held-lock snapshots and reclaim guards", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-reset-");
    const managerKey = `reset-${Date.now()}-${Math.random()}`;
    const manager = createSidecarLockManager(managerKey);
    const targetPath = path.join(directory, "state.json");
    const lock = await manager.acquire({ targetPath, payload: async () => ({ owner: "reset" }) });
    await fs.writeFile(lock.lockPath, "replacement-with-a-different-size");

    const states = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
      string,
      { reclaimGuards: Set<string> }
    >;
    const guardPath = `${lock.lockPath}.manual-reclaim`;
    await fs.mkdir(guardPath);
    states.get(managerKey)?.reclaimGuards.add(guardPath);
    manager.reset();

    await expect(fs.readFile(lock.lockPath, "utf8")).resolves.toBe(
      "replacement-with-a-different-size",
    );
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });
});
