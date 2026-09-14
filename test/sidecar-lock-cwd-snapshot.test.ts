import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import type { SidecarLockAcquireOptions } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("async sidecar cwd snapshots", () => {
  it("pins a relative explicit lock path through acquisition, verification, and release", async () => {
    const before = await tempRoot("fs-safe-sidecar-cwd-before-");
    const after = await tempRoot("fs-safe-sidecar-cwd-after-");
    await Promise.all([
      fs.mkdir(path.join(before, "locks")),
      fs.mkdir(path.join(after, "locks")),
    ]);
    const expectedLockPath = path.join(before, "locks", "state.lock");
    const driftedLockPath = path.join(after, "locks", "state.lock");
    const manager = createFileLockManager(`cwd-acquire:${before}`);
    const previousCwd = process.cwd();

    try {
      process.chdir(before);
      const pending = manager.acquire("state.json", {
        lockPath: path.join("locks", "state.lock"),
        staleMs: 30_000,
        payload: () => ({ owner: "caller-cwd" }),
      });
      process.chdir(after);

      const held = await pending;
      expect(held.lockPath).toBe(expectedLockPath);
      await expect(held.verifyStillHeld()).resolves.toBe(true);
      await expect(fs.stat(expectedLockPath)).resolves.toMatchObject({});
      await expect(fs.stat(driftedLockPath)).rejects.toMatchObject({ code: "ENOENT" });

      await held.release();
      await expect(fs.stat(expectedLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(driftedLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(previousCwd);
      await manager.drain();
    }
  });

  it("keeps stale reclaim on the caller-cwd sidecar after an asynchronous cwd change", async () => {
    const before = await tempRoot("fs-safe-sidecar-reclaim-before-");
    const after = await tempRoot("fs-safe-sidecar-reclaim-after-");
    await Promise.all([
      fs.mkdir(path.join(before, "locks")),
      fs.mkdir(path.join(after, "locks")),
    ]);
    const expectedLockPath = path.join(before, "locks", "state.lock");
    const driftedLockPath = path.join(after, "locks", "state.lock");
    const expectedStale = JSON.stringify({ owner: "stale-before" });
    const driftedStale = JSON.stringify({ owner: "unrelated-after" });
    await Promise.all([
      fs.writeFile(expectedLockPath, expectedStale),
      fs.writeFile(driftedLockPath, driftedStale),
    ]);
    const manager = createFileLockManager(`cwd-reclaim:${before}`);
    const previousCwd = process.cwd();
    const observedPaths: string[] = [];

    try {
      process.chdir(before);
      const pending = manager.acquire("state.json", {
        lockPath: path.join("locks", "state.lock"),
        staleMs: 0,
        retry: { retries: 0 },
        staleRecovery: "remove-if-unchanged",
        payload: () => ({ owner: "replacement-before" }),
        shouldReclaim: ({ lockPath }) => {
          observedPaths.push(lockPath);
          return true;
        },
        shouldRemoveStaleLock: ({ lockPath }) => {
          observedPaths.push(lockPath);
          return true;
        },
      });
      process.chdir(after);

      const held = await pending;
      expect(held.lockPath).toBe(expectedLockPath);
      expect(observedPaths).toEqual([expectedLockPath, expectedLockPath]);
      await expect(fs.readFile(driftedLockPath, "utf8")).resolves.toBe(driftedStale);

      await held.release();
      await expect(fs.stat(expectedLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(driftedLockPath, "utf8")).resolves.toBe(driftedStale);
    } finally {
      process.chdir(previousCwd);
      await manager.drain();
    }
  });

  it("uses one lockRoot snapshot for every acquisition and release phase", async () => {
    const base = await tempRoot("fs-safe-sidecar-root-snapshot-");
    await Promise.all([
      fs.mkdir(path.join(base, "first")),
      fs.mkdir(path.join(base, "second")),
    ]);
    const firstRoot = await root(path.join(base, "first"));
    const secondRoot = await root(path.join(base, "second"));
    const lockPath = path.join(firstRoot.rootReal, "state.lock");
    const manager = createSidecarLockManager(`root-snapshot:${base}`);
    let lockRootReads = 0;
    const options: SidecarLockAcquireOptions<{ owner: string }> = {
      targetPath: path.join(base, "external-state"),
      lockPath,
      staleMs: 30_000,
      payload: () => ({ owner: "first-root" }),
      get lockRoot() {
        lockRootReads += 1;
        return lockRootReads === 1 ? firstRoot : secondRoot;
      },
    };

    const held = await manager.acquire(options);
    expect(lockRootReads).toBe(1);
    await expect(held.verifyStillHeld()).resolves.toBe(true);
    await held.release();
    expect(lockRootReads).toBe(1);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(secondRoot.rootReal, "state.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
