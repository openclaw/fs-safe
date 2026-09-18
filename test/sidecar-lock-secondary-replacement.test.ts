import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

itPosix.each([false, true].flatMap(fallback => [0, 1].map(retries => ({ fallback, retries }))))(
  "retries only fresh creation after two owner handoffs (fallback=$fallback, retries=$retries)",
  async ({ fallback, retries }) => {
    configureFsSafeNative({ mode: "off" });
    const capability = await root(await tempRoot("sidecar-double-handoff-"));
    const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
    const managers = ["original", "second", "third", "waiter"]
      .map(owner => createFileLockManager(`${owner}:${target}`));
    const handles: Awaited<ReturnType<(typeof managers)[number]["acquire"]>>[] = [];
    const retained: FileHandle[] = [];
    const options = { lockRoot: capability, retry: { retries, minTimeout: 0, maxTimeout: 0 } };
    const parsePayload = vi.fn(JSON.parse), shouldReclaim = vi.fn(() => false);
    const rootIdentity = await fs.stat(capability.rootReal, { bigint: true });
    const create = capability.create.bind(capability);
    let freshCreate: ReturnType<typeof vi.spyOn> | undefined;
    let discarded: FileHandle | undefined;
    let probeFailure: unknown;
    let thirdRaw: Buffer | undefined;
    let handoffs = 0;
    const stat = capability.stat.bind(capability);
    vi.spyOn(capability, "stat").mockImplementation(async (...args) => {
      try { return await stat(...args); }
      catch (error) {
        if (args[0] === "state.lock") probeFailure = error;
        throw error;
      }
    });
    try {
      handles[0] = await managers[0].acquire(target, { ...options, payload: () => ({ owner: "original" }) });
      retained[0] = await fs.open(lockPath, "r");
      __setFsSafeTestHooksForTest({
        async afterPreOpenLstat(candidate) {
          if (candidate !== lockPath) return;
          __setFsSafeTestHooksForTest();
          await handles[0].release();
          expect((await retained[0].stat({ bigint: true })).nlink).toBe(0n);
          handles[1] = await managers[1].acquire(target, { ...options, payload: () => ({ owner: "second" }) });
          retained[1] = await fs.open(lockPath, "r");
          handoffs += 1;
          __setFsSafeTestHooksForTest({
            ...(fallback ? { beforeRootStatInitialObservation: () => {} } : {}),
            async beforeRootStatObservation(probePath) {
              if (probePath !== lockPath) return;
              __setFsSafeTestHooksForTest();
              await handles[1].release();
              expect((await retained[1].stat({ bigint: true })).nlink).toBe(0n);
              handles[2] = await managers[2].acquire(target, { ...options, payload: () => ({ owner: "third" }) });
              thirdRaw = await fs.readFile(lockPath);
              handoffs += 1;
              freshCreate = vi.spyOn(capability, "create").mockImplementationOnce(async (...args) => {
                expect(discarded?.fd).toBe(-1);
                expect(managers[3].heldEntries()).toEqual([]);
                expect(parsePayload).not.toHaveBeenCalled();
                expect(shouldReclaim).not.toHaveBeenCalled();
                await expect(handles[2].verifyStillHeld()).resolves.toBe(true);
                expect(await fs.readFile(lockPath)).toEqual(thirdRaw);
                await handles[2].release();
                return await create(...args);
              });
            },
          });
        },
        afterOpen(candidate, handle) { if (candidate === lockPath) discarded = handle; },
      });
      const pending = managers[3].acquire(target, {
        ...options, payload: () => ({ owner: "waiter" }), parsePayload, shouldReclaim,
      });
      if (retries === 0) {
        await expect(pending).rejects.toMatchObject({ code: "file_lock_timeout" });
        expect(freshCreate).not.toHaveBeenCalled();
        await expect(handles[2].verifyStillHeld()).resolves.toBe(true);
        expect(await fs.readFile(lockPath)).toEqual(thirdRaw);
        expect(managers[3].heldEntries()).toEqual([]);
      } else {
        handles[3] = await pending;
        expect(freshCreate).toHaveBeenCalledExactlyOnceWith("state.lock", expect.any(String), expect.any(Object));
        expect(parsePayload).not.toHaveBeenCalled();
        await expect(handles[3].verifyStillHeld()).resolves.toBe(true);
        expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ owner: "waiter" });
      }
      // Root.stat retains its public error; only this acquisition discards the probe.
      expect(probeFailure).toMatchObject({ code: "path-mismatch" });
      expect(handoffs).toBe(2);
      expect(discarded?.fd).toBe(-1);
      expect(parsePayload.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual(retries ? [{ owner: "waiter" }] : []);
      expect(shouldReclaim).not.toHaveBeenCalled();
      const after = await fs.stat(capability.rootReal, { bigint: true });
      expect([after.dev, after.ino]).toEqual([rootIdentity.dev, rootIdentity.ino]);
    } finally {
      __setFsSafeTestHooksForTest();
      vi.restoreAllMocks();
      for (const handle of handles) await handle?.release();
      for (const handle of retained) await handle?.close();
      for (const manager of managers) await manager.drain();
    }
  },
);
