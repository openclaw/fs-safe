import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLock,
  acquireFileLockSync,
  type FileLockHandle,
  type FileLockSyncHandle,
} from "../src/file-lock.js";
import { configureFsSafeLocks } from "../src/lock-config.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const invalidStaleThresholds = [-1, Number.NaN, Number.NEGATIVE_INFINITY];

afterEach(() => {
  configureFsSafeLocks({
    retry: undefined,
    staleMs: undefined,
    staleRecovery: "fail-closed",
    timeoutMs: undefined,
  });
});

describe("file-lock stale threshold validation", () => {
  it.each(invalidStaleThresholds)(
    "rejects async staleMs %s before payload or filesystem mutation",
    async (staleMs) => {
      const base = await tempRoot("fs-safe-lock-stale-async-");
      const parent = path.join(base, "missing");
      const targetPath = path.join(parent, "state.json");
      const manager = createSidecarLockManager(`invalid-stale-async-${String(staleMs)}`);
      const payload = vi.fn(() => ({ createdAt: new Date().toISOString() }));
      let acquired: FileLockHandle | undefined;

      try {
        const acquisition = manager
          .acquire({ targetPath, staleMs, payload })
          .then((handle) => (acquired = handle));
        await expect(acquisition).rejects.toThrow(
          new RangeError("lock staleMs must be a finite non-negative number"),
        );
        expect(payload).not.toHaveBeenCalled();
        await expect(fsp.stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await acquired?.release();
        await manager.drain();
      }
    },
  );

  it.each(invalidStaleThresholds)(
    "rejects sync staleMs %s before payload or filesystem mutation",
    async (staleMs) => {
      const base = await tempRoot("fs-safe-lock-stale-sync-");
      const parent = path.join(base, "missing");
      const targetPath = path.join(parent, "state.json");
      const payload = vi.fn(() => ({ createdAt: new Date().toISOString() }));
      let acquired: FileLockSyncHandle | undefined;

      try {
        expect(() => {
          acquired = acquireFileLockSync(targetPath, { staleMs, payload });
        }).toThrow(new RangeError("lock staleMs must be a finite non-negative number"));
        expect(payload).not.toHaveBeenCalled();
        expect(fs.existsSync(parent)).toBe(false);
      } finally {
        acquired?.release();
      }
    },
  );

  it.each(
    invalidStaleThresholds.flatMap((staleMs) =>
      (["async", "sync"] as const).map((mode) => ({ mode, staleMs })),
    ),
  )("validates configured staleMs $staleMs before $mode acquisition", async ({ mode, staleMs }) => {
    const base = await tempRoot(`fs-safe-lock-stale-config-${mode}-`);
    const parent = path.join(base, "missing");
    const targetPath = path.join(parent, "state.json");
    const payload = vi.fn(() => ({ createdAt: new Date().toISOString() }));
    configureFsSafeLocks({ staleMs });

    if (mode === "async") {
      let acquired: FileLockHandle | undefined;
      try {
        const acquisition = acquireFileLock(targetPath, {
          managerKey: `invalid-config-${Date.now()}`,
          payload,
        }).then((handle) => (acquired = handle));
        await expect(acquisition).rejects.toThrow(
          new RangeError("lock staleMs must be a finite non-negative number"),
        );
      } finally {
        await acquired?.release();
      }
    } else {
      let acquired: FileLockSyncHandle | undefined;
      try {
        expect(() => {
          acquired = acquireFileLockSync(targetPath, { payload });
        }).toThrow(new RangeError("lock staleMs must be a finite non-negative number"));
      } finally {
        acquired?.release();
      }
    }

    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(parent)).toBe(false);
  });

  it("does not let a negative threshold reclaim a live async lock", async () => {
    const base = await tempRoot("fs-safe-lock-live-reclaim-");
    const targetPath = path.join(base, "state.json");
    const holderManager = createSidecarLockManager(`stale-holder-${Date.now()}`);
    const contenderManager = createSidecarLockManager(`stale-contender-${Date.now()}`);
    const holder = await holderManager.acquire({
      targetPath,
      staleMs: 30_000,
      payload: () => ({ createdAt: new Date().toISOString(), owner: "holder" }),
    });
    let contender: FileLockHandle | undefined;

    try {
      const acquisition = contenderManager
        .acquire({
          targetPath,
          staleMs: -1,
          staleRecovery: "remove-if-unchanged",
          payload: () => ({ createdAt: new Date().toISOString(), owner: "contender" }),
          shouldRemoveStaleLock: () => true,
        })
        .then((handle) => (contender = handle));
      await expect(acquisition).rejects.toThrow(
        new RangeError("lock staleMs must be a finite non-negative number"),
      );
      await expect(holder.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await contender?.release();
      await contenderManager.drain();
      await holder.release();
      await holderManager.drain();
    }
  });

  it("does not age-reclaim through an omitted low-level threshold", async () => {
    const base = await tempRoot("fs-safe-lock-omitted-stale-");
    const targetPath = path.join(base, "state.json");
    const holderManager = createSidecarLockManager(`omitted-stale-holder-${Date.now()}`);
    const contenderManager = createSidecarLockManager(`omitted-stale-contender-${Date.now()}`);
    const holder = await holderManager.acquire({
      targetPath,
      staleMs: 30_000,
      payload: () => ({ createdAt: new Date(0).toISOString() }),
    });
    const shouldRemoveStaleLock = vi.fn(() => true);

    const acquisition = contenderManager.acquire({
      targetPath: path.join(base, "state.json"),
      staleMs: undefined as unknown as number,
      timeoutMs: 0,
      retry: { retries: 0 },
      staleRecovery: "remove-if-unchanged",
      shouldRemoveStaleLock,
      payload: () => ({ createdAt: new Date().toISOString() }),
    });

    try {
      await expect(acquisition).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(shouldRemoveStaleLock).not.toHaveBeenCalled();
      await expect(holder.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await contenderManager.drain();
      await holder.release();
      await holderManager.drain();
    }
  });

  it("allows positive infinity as a stale threshold", async () => {
    const base = await tempRoot("fs-safe-lock-infinite-stale-");
    const asyncLock = await acquireFileLock(path.join(base, "async.json"), {
      managerKey: `infinite-stale-${Date.now()}`,
      staleMs: Number.POSITIVE_INFINITY,
      payload: () => ({ createdAt: new Date().toISOString() }),
    });
    const syncLock = acquireFileLockSync(path.join(base, "sync.json"), {
      staleMs: Number.POSITIVE_INFINITY,
      payload: () => ({ createdAt: new Date().toISOString() }),
    });

    try {
      await expect(asyncLock.verifyStillHeld()).resolves.toBe(true);
      expect(syncLock.verifyStillHeld()).toBe(true);
    } finally {
      syncLock.release();
      await asyncLock.release();
    }
  });
});
