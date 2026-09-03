import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeLocks, getFsSafeLockConfig } from "../src/config.js";
import {
  acquireFileLockSync, createFileLockManager,
  type FileLockHandle, type FileLockRetryOptions, type FileLockSyncHandle,
} from "../src/file-lock.js";
import { root } from "../src/root.js";
import * as timing from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const savedConfig = getFsSafeLockConfig();

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeLocks({ retry: undefined, timeoutMs: undefined, ...savedConfig });
});

for (const mode of ["async", "Root async", "sync", "Root sync"] as const) {
  describe(`${mode} independent lock budgets`, () => {
    async function fixture(releaseAfterWaits: number) {
      const directory = await tempRoot("fs-safe-lock-budget-");
      const lockRoot = mode.startsWith("Root") ? await root(directory) : undefined;
      const target = path.join(directory, "state");
      const lockPath = `${target}.lock`;
      const holder = acquireFileLockSync(target, { lockRoot, payload: () => ({ owner: "holder" }) });
      const original = fs.readFileSync(lockPath, "utf8");
      const manager = createFileLockManager(`budget:${target}`);
      const acquired: Array<FileLockHandle | FileLockSyncHandle> = [];
      const payload = vi.fn(() => ({ owner: "waiter" }));
      const waits: number[] = [];
      const startedAt = Date.now();
      let elapsed = 0;
      vi.spyOn(Date, "now").mockImplementation(() => startedAt + elapsed);
      // Control only sleeps; use real exclusive creation and owner-authorized release.
      // Releasing at the first excess wait also bounds a broken retry loop without a sentinel.
      const sleep = (ms: number) => {
        waits.push(ms);
        elapsed += ms;
        if (waits.length >= releaseAfterWaits) holder.release();
      };
      vi.spyOn(timing, "sleepSync").mockImplementation(sleep);
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms = 0, ...args) => {
        sleep(ms);
        queueMicrotask(() => callback(...args));
        return {} as ReturnType<typeof setTimeout>;
      });
      const acquire = async (retry?: FileLockRetryOptions, timeoutMs?: number) => {
        const options = { lockRoot, payload, retry, timeoutMs, shouldReclaim: () => false };
        const lock = mode.endsWith("async")
          ? await manager.acquire(target, options)
          : acquireFileLockSync(target, options);
        acquired.push(lock);
        return lock;
      };
      const cleanup = async () => {
        holder.release();
        for (const lock of acquired) await lock.release();
        await manager.drain();
      };
      return { holder, original, lockPath, manager, payload, waits, acquire, cleanup };
    }

    it.each([0, 2])("honors %s retries with an infinite deadline", async (retries) => {
      const { holder, original, lockPath, manager, payload, waits, acquire, cleanup } = await fixture(retries + 1);
      try {
        await expect(acquire({ retries, minTimeout: 0, maxTimeout: 0 }, Infinity))
          .rejects.toMatchObject({ code: "file_lock_timeout", lockPath });
        expect(payload).toHaveBeenCalledTimes(retries + 1);
        expect(waits).toEqual(Array(retries).fill(0));
        expect(holder.verifyStillHeld()).toBe(true);
        expect(fs.readFileSync(lockPath, "utf8")).toBe(original);
        expect(manager.heldEntries()).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it.each([1, 3])("acquires on the final allowed retry (%s)", async (retries) => {
      const { lockPath, payload, waits, acquire, cleanup } = await fixture(retries);
      try {
        const lock = await acquire({ retries, minTimeout: 10, maxTimeout: 10 }, Infinity);
        try {
          expect(payload).toHaveBeenCalledTimes(retries + 1);
          expect(waits).toEqual(Array(retries).fill(10));
          expect(await lock.verifyStillHeld()).toBe(true);
          expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual({ owner: "waiter" });
        } finally {
          await lock.release();
        }
        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it.each([
      { retry: undefined, timeoutMs: undefined }, { retry: {}, timeoutMs: undefined },
      { retry: undefined, timeoutMs: Infinity }, { retry: {}, timeoutMs: Infinity },
    ])("keeps omitted counts unbounded (retry $retry, timeout $timeoutMs)", async ({ retry, timeoutMs }) => {
      const { payload, waits, acquire, cleanup } = await fixture(12);
      try {
        const lock = await acquire(retry, timeoutMs);
        try {
          expect(payload).toHaveBeenCalledTimes(13);
          expect(waits).toEqual(Array(12).fill(50));
          expect(await lock.verifyStillHeld()).toBe(true);
        } finally {
          await lock.release();
        }
      } finally {
        await cleanup();
      }
    });

    it("stops at the finite deadline before exhausting retries", async () => {
      const { holder, payload, waits, acquire, cleanup } = await fixture(4);
      try {
        await expect(acquire({ retries: 3, minTimeout: 10, maxTimeout: 10 }, 15))
          .rejects.toMatchObject({ code: "file_lock_timeout" });
        expect(payload).toHaveBeenCalledTimes(3);
        expect(waits).toEqual([10, 5]);
        expect(holder.verifyStillHeld()).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("honors configured counts and replaces them with a per-call retry object", async () => {
      const { payload, waits, acquire, cleanup } = await fixture(3);
      configureFsSafeLocks({ timeoutMs: Infinity, retry: { retries: 0 } });
      try {
        await expect(acquire()).rejects.toMatchObject({ code: "file_lock_timeout" });
        expect(payload).toHaveBeenCalledTimes(1);
        expect(waits).toEqual([]);
        const lock = await acquire({ minTimeout: 5, maxTimeout: 5 });
        try {
          expect(payload).toHaveBeenCalledTimes(5);
          expect(waits).toEqual([5, 5, 5]);
          expect(await lock.verifyStillHeld()).toBe(true);
        } finally {
          await lock.release();
        }
      } finally {
        await cleanup();
      }
    });
  });
}
