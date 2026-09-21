import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.each([false, true])("detached lock methods with lockRoot=%s", (rooted) => {
  it("shares concurrent release and disposal failures, then retries the retained cleanup", async () => {
    const directory = await tempRoot("fs-safe-detached-release-");
    const capability = rooted ? await root(directory) : undefined;
    const manager = createFileLockManager(`detached-release:${directory}`);
    const targetPath = path.join(directory, "state.json");
    const options = { lockRoot: capability, reentrantOwner: "owner", payload: () => ({}) };
    const failure = Object.assign(new Error("pending cleanup failed"), { code: "EIO" });
    let entered!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const allowCleanup = new Promise<void>((resolve) => { finish = resolve; });
    const pending: Promise<void>[] = [];
    let restore = () => {};
    let attempts = 0;
    const beforeRemoval = async () => {
      attempts++;
      if (attempts === 1) {
        entered();
        await allowCleanup;
        throw failure;
      }
    };

    try {
      const first = await manager.acquire(targetPath, options);
      const second = await manager.acquire(targetPath, options);
      const verifyFirst = first.verifyStillHeld;
      const releaseFirst = first.release;
      await releaseFirst();
      await releaseFirst();
      await expect(verifyFirst()).resolves.toBe(true);

      const verify = second.verifyStillHeld;
      const release = second.release;
      const dispose = second[Symbol.asyncDispose];
      expect(dispose).toBe(release);
      await expect(verify()).resolves.toBe(true);
      if (capability) {
        const remove = capability.remove.bind(capability);
        const spy = vi.spyOn(capability, "remove").mockImplementation(async (...args) => {
          await beforeRemoval();
          return await remove(...args);
        });
        restore = () => spy.mockRestore();
      } else {
        const remove = fs.rm.bind(fs);
        const spy = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
          if (path.resolve(String(target)) === second.lockPath) await beforeRemoval();
          return await remove(target, ...args);
        });
        restore = () => spy.mockRestore();
      }

      pending.push(release(), dispose());
      let outcomes: PromiseSettledResult<void>[] | undefined;
      const settlement = Promise.allSettled(pending).then((results) => { outcomes = results; });
      await cleanupEntered;
      expect(attempts).toBe(1);
      expect(outcomes).toBeUndefined();
      expect((await fs.lstat(second.lockPath)).isFile()).toBe(true);
      finish();
      await settlement;
      expect(outcomes).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      for (const outcome of outcomes!) {
        expect(outcome.status === "rejected" && outcome.reason).toBe(failure);
      }
      await expect(verify()).resolves.toBe(true);
      expect(manager.heldEntries()).toHaveLength(1);

      await dispose();
      expect(attempts).toBe(2);
      await expect(fs.lstat(second.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(verify()).resolves.toBe(false);
      await expect(verifyFirst()).resolves.toBe(false);
      expect(manager.heldEntries()).toEqual([]);
      await release();
      await dispose();
      expect(attempts).toBe(2);
    } finally {
      finish();
      await Promise.allSettled(pending);
      restore();
      await manager.drain();
    }
  });
});
