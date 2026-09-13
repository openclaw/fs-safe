import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLockSync,
  type FileLockHandle,
  type FileLockSyncHandle,
} from "../src/file-lock.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const invalidIntervals = [
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  -1,
  0.5,
  2 ** 31,
  Number.MAX_VALUE,
];
const intervalError = new RangeError(
  "lock compromiseCheckIntervalMs must be 0 or a finite number between 1 and 2147483647",
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("file-lock compromise interval validation", () => {
  it.each(invalidIntervals)(
    "rejects async interval %s before payload, filesystem mutation, or timer registration",
    async (compromiseCheckIntervalMs) => {
      const base = await tempRoot("fs-safe-lock-interval-async-");
      const parent = path.join(base, "missing");
      const targetPath = path.join(parent, "state.json");
      const manager = createSidecarLockManager(`invalid-interval-async-${String(compromiseCheckIntervalMs)}`);
      const payload = vi.fn(() => ({ owner: "test" }));
      const onCompromised = compromiseCheckIntervalMs === Number.MAX_VALUE ? undefined : vi.fn();
      const interval = vi.spyOn(globalThis, "setInterval");
      let acquired: FileLockHandle | undefined;

      try {
        const acquisition = manager.acquire({
          targetPath,
          staleMs: 30_000,
          compromiseCheckIntervalMs,
          onCompromised,
          payload,
        }).then((handle) => (acquired = handle));
        await expect(acquisition).rejects.toThrow(intervalError);
        expect(payload).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        await expect(fs.stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await acquired?.release();
        await manager.drain();
      }
    },
  );

  it.each(invalidIntervals)(
    "rejects sync interval %s before payload, filesystem mutation, or timer registration",
    async (compromiseCheckIntervalMs) => {
      const base = await tempRoot("fs-safe-lock-interval-sync-");
      const parent = path.join(base, "missing");
      const targetPath = path.join(parent, "state.json");
      const payload = vi.fn(() => ({ owner: "test" }));
      const onCompromised = compromiseCheckIntervalMs === Number.MAX_VALUE ? undefined : vi.fn();
      const interval = vi.spyOn(globalThis, "setInterval");
      let acquired: FileLockSyncHandle | undefined;

      try {
        expect(() => {
          acquired = acquireFileLockSync(targetPath, {
            compromiseCheckIntervalMs,
            onCompromised,
            payload,
          });
        }).toThrow(intervalError);
        expect(payload).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(fsSync.existsSync(parent)).toBe(false);
      } finally {
        acquired?.release();
      }
    },
  );

  it("accepts disabled and maximum intervals without changing the timer delay", async () => {
    const base = await tempRoot("fs-safe-lock-interval-boundary-");
    const manager = createSidecarLockManager(`interval-boundary-${Date.now()}`);
    const fakeTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const interval = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimer);
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const disabled = await manager.acquire({
      targetPath: path.join(base, "disabled.json"),
      staleMs: 30_000,
      compromiseCheckIntervalMs: 0,
      onCompromised: vi.fn(),
      payload: () => ({ owner: "disabled" }),
    });
    expect(interval).not.toHaveBeenCalled();
    await disabled.release();

    const maximum = await manager.acquire({
      targetPath: path.join(base, "maximum.json"),
      staleMs: 30_000,
      compromiseCheckIntervalMs: 2 ** 31 - 1,
      onCompromised: vi.fn(),
      payload: () => ({ owner: "maximum" }),
    });
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0]?.[1]).toBe(2 ** 31 - 1);
    expect(fakeTimer.unref).toHaveBeenCalledTimes(1);
    await maximum.release();
    expect(clear).toHaveBeenCalledWith(fakeTimer);
    await manager.drain();
  });

  it("validates a reentrant acquisition before incrementing its held reference", async () => {
    const base = await tempRoot("fs-safe-lock-interval-reentrant-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`interval-reentrant-${Date.now()}`);
    const held = await manager.acquire({
      targetPath,
      staleMs: 30_000,
      reentrantOwner: "owner",
      payload: () => ({ owner: "first" }),
    });

    await expect(manager.acquire({
      targetPath,
      staleMs: 30_000,
      reentrantOwner: "owner",
      compromiseCheckIntervalMs: Number.POSITIVE_INFINITY,
      payload: () => ({ owner: "second" }),
    })).rejects.toThrow(intervalError);

    await held.release();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.drain();
  });
});
