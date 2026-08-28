import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function lockOptions() {
  return {
    payload: () => ({ createdAt: new Date().toISOString() }),
    timeoutMs: 0,
    retry: { retries: 0 },
  } as const;
}

describe("synchronous file-lock failure handling", () => {
  it("removes a partially-created lock when payload persistence fails", async () => {
    const root = await tempRoot("fs-safe-sync-lock-write-failure-");
    const targetPath = path.join(root, "state.json");
    const lockPath = `${targetPath}.lock`;
    const failure = Object.assign(new Error("disk write failed"), { code: "EIO" });
    vi.spyOn(fsSync, "writeFileSync").mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => acquireFileLockSync(targetPath, lockOptions())).toThrow(failure);
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  it("removes a partially-created lock when fsync fails", async () => {
    const root = await tempRoot("fs-safe-sync-lock-fsync-failure-");
    const targetPath = path.join(root, "state.json");
    const lockPath = `${targetPath}.lock`;
    const failure = Object.assign(new Error("fsync failed"), { code: "EIO" });
    vi.spyOn(fsSync, "fsyncSync").mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => acquireFileLockSync(targetPath, lockOptions())).toThrow(failure);
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  it("fails closed on stale locks unless unchanged removal is explicitly approved", async () => {
    const root = await tempRoot("fs-safe-sync-lock-stale-");
    const targetPath = path.join(root, "state.json");
    const lockPath = `${targetPath}.lock`;
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    expect(() =>
      acquireFileLockSync(targetPath, {
        ...lockOptions(),
        staleMs: 1,
        staleRecovery: "remove-if-unchanged",
        shouldReclaim: () => true,
        shouldRemoveStaleLock: () => false,
      }),
    ).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("2000");

    const lock = acquireFileLockSync(targetPath, {
      ...lockOptions(),
      staleMs: 1,
      staleRecovery: "remove-if-unchanged",
      shouldReclaim: () => true,
      shouldRemoveStaleLock: (snapshot) => snapshot.raw.includes("2000"),
    });
    expect(lock.verifyStillHeld()).toBe(true);
    lock.release();
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  it("uses file age for corrupt legacy locks and preserves them on stale failure", async () => {
    const root = await tempRoot("fs-safe-sync-lock-corrupt-");
    const targetPath = path.join(root, "state.json");
    const lockPath = `${targetPath}.lock`;
    await fs.writeFile(lockPath, "{");
    await fs.utimes(lockPath, new Date(0), new Date(0));

    expect(() =>
      acquireFileLockSync(targetPath, { ...lockOptions(), staleMs: 1 }),
    ).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("{");
  });

  it("fails closed if stale-lock metadata cannot be inspected", async () => {
    const root = await tempRoot("fs-safe-sync-lock-stat-failure-");
    const targetPath = path.join(await fs.realpath(root), "state.json");
    const lockPath = `${targetPath}.lock`;
    await fs.writeFile(lockPath, "{}");
    const realStat = fsSync.statSync.bind(fsSync);
    vi.spyOn(fsSync, "statSync").mockImplementation((filePath, options) => {
      if (String(filePath) === lockPath) {
        throw Object.assign(new Error("inspection denied"), { code: "EACCES" });
      }
      return realStat(filePath, options as never);
    });

    expect(() =>
      acquireFileLockSync(targetPath, { ...lockOptions(), staleMs: 60_000 }),
    ).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("{}");
  });

  it("propagates reclaim-guard creation failures and leaves the stale lock intact", async () => {
    const root = await tempRoot("fs-safe-sync-lock-reclaim-failure-");
    const targetPath = path.join(await fs.realpath(root), "state.json");
    const lockPath = `${targetPath}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));
    const realMkdir = fsSync.mkdirSync.bind(fsSync);
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((directory, options) => {
      if (String(directory) === reclaimPath) {
        throw Object.assign(new Error("reclaim guard denied"), { code: "EACCES" });
      }
      return realMkdir(directory, options as never);
    });

    expect(() =>
      acquireFileLockSync(targetPath, {
        ...lockOptions(),
        staleMs: 1,
        staleRecovery: "remove-if-unchanged",
        shouldReclaim: () => true,
        shouldRemoveStaleLock: () => true,
      }),
    ).toThrow(expect.objectContaining({ code: "EACCES" }));
    await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("2000");
  });

  it("reports compromised ownership and preserves the replacement on release", async () => {
    const root = await tempRoot("fs-safe-sync-lock-compromised-");
    const targetPath = path.join(root, "state.json");
    let compromised: { lockPath: string; normalizedTargetPath: string } | undefined;
    const lock = acquireFileLockSync(targetPath, {
      ...lockOptions(),
      compromiseCheckIntervalMs: 2,
      onCompromised: (info) => {
        compromised = info;
      },
    });
    await fs.writeFile(lock.lockPath, "replacement");

    await vi.waitFor(() => expect(compromised).toEqual({
      lockPath: lock.lockPath,
      normalizedTargetPath: lock.normalizedTargetPath,
    }));
    expect(lock.verifyStillHeld()).toBe(false);
    lock.release();
    await expect(fs.readFile(lock.lockPath, "utf8")).resolves.toBe("replacement");
  });

  it("treats a thrown compromise check as a lost lock instead of an uncaught exception", async () => {
    const root = await tempRoot("fs-safe-sync-lock-timer-throw-");
    const targetPath = path.join(root, "state.json");
    const compromised = vi.fn();
    const exceptions: unknown[] = [];
    const onUncaught = (error: unknown) => {
      exceptions.push(error);
    };
    process.on("uncaughtException", onUncaught);
    let lock: ReturnType<typeof acquireFileLockSync> | undefined;
    try {
      lock = acquireFileLockSync(targetPath, {
        ...lockOptions(),
        compromiseCheckIntervalMs: 10,
        onCompromised: compromised,
      });
      const failure = Object.assign(new Error("lock snapshot failed"), { code: "EIO" });
      const realLstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((filePath, options) => {
        if (String(filePath) === lock.lockPath) {
          throw failure;
        }
        return realLstat(filePath, options as never);
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
      expect(exceptions).toEqual([]);
      expect(() => lock.verifyStillHeld()).toThrow(failure);
    } finally {
      process.off("uncaughtException", onUncaught);
      vi.restoreAllMocks();
      lock?.release();
    }
  });

  it("falls back to the resolved target when parent realpath lookup fails", async () => {
    const root = await tempRoot("fs-safe-sync-lock-realpath-failure-");
    const targetPath = path.join(root, "state.json");
    vi.spyOn(fsSync, "realpathSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("realpath unavailable"), { code: "EIO" });
    });

    const lock = acquireFileLockSync(targetPath, lockOptions());
    expect(lock.normalizedTargetPath).toBe(path.resolve(targetPath));
    lock.release();
  });

  it("makes repeated release and disposal idempotent", async () => {
    const root = await tempRoot("fs-safe-sync-lock-release-");
    const lock = acquireFileLockSync(path.join(root, "state.json"), lockOptions());
    lock.release();
    lock.release();
    lock[Symbol.dispose]();
    expect(fsSync.existsSync(lock.lockPath)).toBe(false);
  });

  itPosix("bounds synchronous lock paths through a Root capability", async () => {
    const directory = await tempRoot("fs-safe-sync-lock-root-");
    const lockDirectory = path.join(directory, "locks");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const targetPath = path.join(directory, "state.json");
    const lock = acquireFileLockSync(targetPath, {
      ...lockOptions(),
      lockPath: path.join(lockDirectory, "state.lock"),
      lockRoot,
    });
    lock.release();
    expect(() => acquireFileLockSync(targetPath, {
      ...lockOptions(),
      lockPath: path.join(directory, "outside.lock"),
      lockRoot,
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));
  });

  itWin32("fails closed when a synchronous lock parent cannot match the Root canonical path", async () => {
    const directory = await tempRoot("fs-safe-sync-lock-root-win32-");
    const lockDirectory = path.join(directory, "locks");
    const lockPath = path.join(lockDirectory, "state.lock");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);

    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      ...lockOptions(),
      lockPath,
      lockRoot,
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  it("sleeps for a bounded retry before timing out on an in-process holder", async () => {
    const directory = await tempRoot("fs-safe-sync-lock-retry-");
    const targetPath = path.join(directory, "state.json");
    const held = acquireFileLockSync(targetPath, lockOptions());
    expect(() => acquireFileLockSync(targetPath, {
      payload: () => ({}),
      retry: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    held.release();
  });

  it("propagates reclaim-guard inspection failures", async () => {
    const directory = await tempRoot("fs-safe-sync-lock-guard-inspect-");
    const targetPath = path.join(await fs.realpath(directory), "state.json");
    const guardPath = `${targetPath}.lock.reclaim`;
    const realLstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((pathname, options) => {
      if (String(pathname) === guardPath) {
        throw Object.assign(new Error("guard inspection denied"), { code: "EACCES" });
      }
      return realLstat(pathname, options as never);
    });
    expect(() => acquireFileLockSync(targetPath, lockOptions())).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  });

  itPosix("rejects a lexically-contained lock parent that resolves outside lockRoot", async () => {
    const directory = await tempRoot("fs-safe-sync-lock-root-parent-swap-");
    const lockDirectory = path.join(directory, "locks");
    const outside = path.join(directory, "outside");
    const linkedParent = path.join(lockDirectory, "linked");
    await fs.mkdir(lockDirectory);
    await fs.mkdir(outside);
    await fs.symlink(outside, linkedParent);
    const lockRoot = await root(lockDirectory);

    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      ...lockOptions(),
      lockPath: path.join(linkedParent, "state.lock"),
      lockRoot,
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));
    await expect(fs.access(path.join(outside, "state.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
