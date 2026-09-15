import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import type { HeldSidecarLock } from "../src/sidecar-lock-acquire.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

type SharedManagerState = {
  held: Map<string, HeldSidecarLock>;
  reclaimGuards?: Set<string>;
  reclaimCleanupRegistered?: boolean;
};

function managerState(key: string): SharedManagerState {
  const managers = (globalThis as Record<symbol, Map<string, SharedManagerState>>)[
    Symbol.for("fsSafe.sidecarLockManagers")
  ];
  return managers.get(key)!;
}

describe("shared sidecar manager state", () => {
  it.each([0, 32, 128])("constructs wrappers without visiting %s retained locks", async (count) => {
    const directory = await tempRoot("fs-safe-lock-manager-scaling-");
    const key = `scaling:${directory}`;
    const manager = createFileLockManager(key);
    try {
      for (let index = 0; index < count; index++) {
        await manager.acquire(path.join(directory, `${index}.json`), { payload: () => ({}) });
      }
      const held = managerState(key).held;
      const values = held.values.bind(held);
      let visited = 0;
      const traversal = vi.spyOn(held, "values").mockImplementation(function* () {
        for (const entry of values()) {
          visited++;
          yield entry;
        }
      });
      try {
        for (let index = 0; index < 100; index++) createFileLockManager(key);
        expect(visited).toBe(0);
        expect(manager.heldEntries()).toHaveLength(count);
      } finally {
        traversal.mockRestore();
      }
    } finally {
      await manager.drain();
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("retains a legacy holder until every same-owner handle releases", async () => {
    const directory = await tempRoot("fs-safe-lock-manager-legacy-reentrant-");
    const key = `legacy-reentrant:${directory}`;
    const manager = createFileLockManager(key);
    const targetPath = path.join(directory, "state.json");
    const options = { reentrantOwner: "owner", payload: () => ({}) };
    const first = await manager.acquire(targetPath, options);
    const held = managerState(key).held.get(first.normalizedTargetPath)!;
    // Another package copy can populate shared state after this wrapper exists.
    delete (held as Partial<HeldSidecarLock>).refCount;
    try {
      const second = await manager.acquire(targetPath, options);
      try {
        await second.release();
        await second.release();
        await expect(first.verifyStillHeld()).resolves.toBe(true);
        expect(held.refCount).toBe(1);
      } finally {
        await second.release();
      }
      await first.release();
      await expect(fs.lstat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.drain();
    }
  });

  it("lazily initializes a legacy final release without scanning unrelated holders", async () => {
    const directory = await tempRoot("fs-safe-lock-manager-legacy-release-");
    const key = `legacy-release:${directory}`;
    const manager = createFileLockManager(key);
    const first = await manager.acquire(path.join(directory, "first.json"), { payload: () => ({}) });
    const second = await manager.acquire(path.join(directory, "second.json"), { payload: () => ({}) });
    const state = managerState(key);
    const held = state.held.get(first.normalizedTargetPath)!;
    delete (held as Partial<HeldSidecarLock>).refCount;
    delete state.reclaimGuards;
    delete state.reclaimCleanupRegistered;
    try {
      const reopened = createFileLockManager(key);
      expect(state.reclaimGuards).toBeInstanceOf(Set);
      expect(state.reclaimCleanupRegistered).toBe(false);
      expect(held.refCount).toBeUndefined();
      await first.release();
      expect(held.refCount).toBe(0);
      await expect(fs.lstat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(second.verifyStillHeld()).resolves.toBe(true);
      expect(reopened.heldEntries()).toHaveLength(1);
    } finally {
      await manager.drain();
    }
  });
});
