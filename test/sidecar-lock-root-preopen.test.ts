import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { sidecarStagingPath } from "../src/sidecar-lock-staging.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import * as timing from "../src/timing.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32").each(["completed", "publishing"] as const)("retries a %s handoff between pre-open lstat and open without adopting the successor", async phase => {
  configureFsSafeNative({ mode: "off" });
  const capability = await root(await tempRoot("sidecar-preopen-handoff-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const ownerManager = createFileLockManager(`preopen-owner:${target}`);
  const successorManager = createFileLockManager(`preopen-successor:${target}`);
  const waiterManager = createFileLockManager(`preopen-waiter:${target}`);
  const options = { lockRoot: capability, retry: { retries: 2, minTimeout: 0, maxTimeout: 0 } };
  const stage = sidecarStagingPath(lockPath);
  const owner = await ownerManager.acquire(target, { ...options, payload: () => ({ owner: "original" }) });
  const retained = await fs.open(lockPath, "r");
  const original = await retained.stat({ bigint: true });
  const parsePayload = vi.fn(JSON.parse), shouldReclaim = vi.fn(() => false);
  let successor: Awaited<ReturnType<typeof successorManager.acquire>> | undefined;
  let waiter: Awaited<ReturnType<typeof waiterManager.acquire>> | undefined;
  let discarded: FileHandle | undefined;
  let freshCreate = false;
  let handoff = false;
  __setFsSafeTestHooksForTest({
    async afterPreOpenLstat(candidate) {
      if (candidate !== lockPath || handoff) return;
      handoff = true;
      __setFsSafeTestHooksForTest();
      await owner.release();
      expect((await retained.stat({ bigint: true })).nlink).toBe(0n);
      successor = await successorManager.acquire(target, { ...options, payload: () => ({ owner: "successor" }) });
      const replacement = await fs.lstat(lockPath, { bigint: true });
      expect([replacement.dev, replacement.ino]).not.toEqual([original.dev, original.ino]);
      const bytes = await fs.readFile(lockPath);
      if (phase === "publishing") await fs.link(lockPath, stage);
      const assertSuccessor = async () => {
        expect(await fs.readFile(lockPath)).toEqual(bytes);
        const current = await fs.lstat(lockPath, { bigint: true });
        expect([current.dev, current.ino]).toEqual([replacement.dev, replacement.ino]);
        expect(current.nlink).toBe(phase === "publishing" ? 2n : 1n);
        if (phase === "publishing") {
          const staged = await fs.lstat(stage, { bigint: true });
          expect([staged.dev, staged.ino]).toEqual([replacement.dev, replacement.ino]);
          expect(await fs.readFile(stage)).toEqual(bytes);
        }
      };
      const backoff = vi.spyOn(timing, "sleep").mockImplementation(async () => {
        expect(discarded?.fd).toBe(-1);
        expect(waiterManager.heldEntries()).toEqual([]);
        expect(parsePayload).not.toHaveBeenCalled();
        expect(shouldReclaim).not.toHaveBeenCalled();
        await assertSuccessor();
        if (freshCreate) {
          // A fresh exclusive create has now encountered the live publication.
          await fs.unlink(stage);
          await expect(successor!.verifyStillHeld()).resolves.toBe(true);
          await successor!.release();
        }
      });
      const create = capability.create.bind(capability);
      vi.spyOn(capability, "create").mockImplementationOnce(async (...args) => {
        expect(discarded?.fd).toBe(-1);
        expect(waiterManager.heldEntries()).toEqual([]);
        expect(parsePayload).not.toHaveBeenCalled();
        expect(shouldReclaim).not.toHaveBeenCalled();
        await assertSuccessor();
        expect(backoff).toHaveBeenCalledOnce();
        if (phase === "completed") await successor!.release();
        freshCreate = true;
        return await create(...args);
      });
    },
    afterOpen(candidate, handle) {
      if (candidate === lockPath && !discarded) discarded = handle;
    },
  });
  try {
    waiter = await waiterManager.acquire(target, {
      ...options, payload: () => ({ owner: "waiter" }), parsePayload, shouldReclaim,
    });
    expect(handoff).toBe(true);
    expect(freshCreate).toBe(true);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(shouldReclaim).not.toHaveBeenCalled();
    expect(timing.sleep).toHaveBeenCalledTimes(phase === "publishing" ? 2 : 1);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ owner: "waiter" });
    await expect(waiter.verifyStillHeld()).resolves.toBe(true);
  } finally {
    __setFsSafeTestHooksForTest();
    vi.restoreAllMocks();
    await fs.rm(stage, { force: true });
    await waiter?.release();
    await successor?.release();
    await owner.release();
    await retained.close();
    await ownerManager.drain();
    await successorManager.drain();
    await waiterManager.drain();
  }
});
