import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLockSync, createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __setFsSafeTestHooksForTest(); vi.restoreAllMocks(); });

it.skipIf(process.platform === "win32")("uses the sampled mtime when a holder retires before stale detection", async () => {
  const capability = await root(await tempRoot("sidecar-mtime-handoff-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const options = { lockRoot: capability, staleMs: 60_000, retry: { retries: 2, minTimeout: 0, maxTimeout: 0 } };
  let holder = acquireFileLockSync(target, { ...options, payload: () => ({ owner: "original" }) });
  const manager = createFileLockManager(`mtime-waiter:${target}`);
  let waiter: Awaited<ReturnType<typeof manager.acquire>> | undefined;
  let retired = false;
  let stalePathProbes = 0;
  const create = capability.create.bind(capability);
  vi.spyOn(capability, "create").mockImplementation(async (...args) => {
    retired = false;
    return await create(...args);
  });
  const stat = fsSync.statSync.bind(fsSync);
  // Rendezvous at the historical pathname-mtime lookup, after the real owner
  // has released. Preserve the real ENOENT, then let a successor acquire.
  vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
    if (!retired || args[0] !== lockPath || args.length !== 1) return stat(...args);
    stalePathProbes += 1;
    try { return stat(...args); }
    finally {
      retired = false;
      holder = acquireFileLockSync(target, { ...options, payload: () => ({ owner: "successor" }) });
      __setFsSafeTestHooksForTest({ beforeRootReadFinalFence(candidate) {
        if (candidate !== lockPath) return;
        __setFsSafeTestHooksForTest();
        holder.release();
        holder = acquireFileLockSync(target, { ...options, payload: () => ({ owner: "third" }) });
      } });
    }
  });
  const parsePayload = vi.fn((raw: string) => {
    const payload = JSON.parse(raw);
    if (payload.owner === "original") {
      holder.release();
      retired = true;
    }
    return payload;
  });
  try {
    waiter = await manager.acquire(target, { ...options, payload: () => ({ owner: "waiter" }), parsePayload });
    expect(stalePathProbes).toBe(0);
    expect(parsePayload.mock.calls.map(([raw]) => JSON.parse(raw).owner)).toEqual(["original"]);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ owner: "waiter" });
    await expect(waiter.verifyStillHeld()).resolves.toBe(true);
  } finally {
    __setFsSafeTestHooksForTest();
    vi.restoreAllMocks();
    await waiter?.release();
    holder.release();
    await manager.drain();
  }
});
