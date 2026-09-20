import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLockSync, createFileLockManager } from "../src/file-lock.js";
import { getRootSyncHeldLocks, readRootSidecarSnapshotSync } from "../src/file-lock-sync-root-held.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import {
  readSidecarLockSnapshot,
  readSidecarLockSnapshotSync,
} from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const modes = [
  { name: "raw async", rootBound: false, sync: false },
  { name: "Root async", rootBound: true, sync: false },
  { name: "raw sync", rootBound: false, sync: true },
  { name: "Root sync", rootBound: true, sync: true },
] as const;
type Mode = typeof modes[number];
const payload = { marker: "owned-comparison", records: Array.from({ length: 256 }, (_, index) => ({ index })) };

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

async function fixture(mode: Mode, parsePayload?: unknown) {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-lock-comparison-");
  const target = path.join(directory, "state");
  const lockRoot = mode.rootBound ? await root(directory) : undefined;
  const manager = createFileLockManager(`ownership-parsing:${target}`);
  const options = {
    lockRoot, payload: () => payload, retry: { retries: 0 },
    parsePayload: parsePayload as ((raw: string) => unknown) | undefined,
  };
  const lock = mode.sync ? acquireFileLockSync(target, options) : await manager.acquire(target, options);
  return { directory, lockRoot, manager, lock };
}

it.each(modes)("$name preserves custom parser calls, unbound receivers, and unused results", async mode => {
  const returnedPayload = new Proxy({}, { get() { throw new Error("parsed comparison payload was consumed"); } });
  const receivers: unknown[] = [];
  const parser = vi.fn(function (this: unknown, raw: string) {
    receivers.push(this);
    expect(JSON.parse(raw)).toEqual(payload);
    return returnedPayload;
  });
  const f = await fixture(mode, parser);
  try {
    expect(parser).not.toHaveBeenCalled();
    expect(await f.lock.verifyStillHeld()).toBe(true);
    expect(parser).toHaveBeenCalledTimes(1);
    await f.lock.release();
    expect(parser).toHaveBeenCalledTimes(mode.sync ? 1 : 2);
    expect(receivers.every(receiver => receiver === undefined)).toBe(true);
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.lock.release(); }
});

for (const parsePayload of [undefined, null, false, 0, NaN, ""]) {
  it.each(modes)(`$name retains default behavior for falsy parser ${String(parsePayload)}`, async mode => {
    const f = await fixture(mode, parsePayload);
    try {
      expect(await f.lock.verifyStillHeld()).toBe(true);
      await f.lock.release();
      expect(await fs.readdir(f.directory)).toEqual([]);
    } finally { await f.lock.release(); }
  });
}

for (const parsePayload of [true, 1, "invalid", {}]) {
  it.each(modes)(`$name rejects truthy non-callable parser ${String(parsePayload)}`, async mode => {
    const f = await fixture(mode, parsePayload);
    const original = await fs.readFile(f.lock.lockPath, "utf8");
    try {
      await expect((async () => await f.lock.verifyStillHeld())()).rejects.toBeInstanceOf(TypeError);
      if (mode.sync) await f.lock.release();
      else {
        await expect(f.lock.release()).rejects.toBeInstanceOf(TypeError);
        expect(await fs.readFile(f.lock.lockPath, "utf8")).toBe(original);
      }
    } finally {
      if (mode.sync) f.lock.release();
      else f.manager.reset();
    }
  });
}

for (const failure of [undefined, null, new Error("custom parser failure")]) {
  it.each(modes)(`$name preserves a custom parser's ${String(failure)} failure`, async mode => {
    let fail = true;
    const parser = vi.fn(() => { if (fail) throw failure; return null; });
    const f = await fixture(mode, parser);
    const original = await fs.readFile(f.lock.lockPath, "utf8");
    try {
      await expect((async () => await f.lock.verifyStillHeld())()).rejects.toBe(failure);
      expect(parser).toHaveBeenCalledTimes(1);
      if (mode.sync) {
        await f.lock.release();
        expect(parser).toHaveBeenCalledTimes(1);
      } else {
        await expect(f.lock.release()).rejects.toBe(failure);
        expect(parser).toHaveBeenCalledTimes(2);
        expect(await fs.readFile(f.lock.lockPath, "utf8")).toBe(original);
      }
    } finally {
      fail = false;
      await f.lock.release();
    }
  });
}

it.each(modes)("$name still decodes default payloads for stale policy", async mode => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-lock-stale-parsing-");
  const target = path.join(directory, "state");
  const foreign = { owner: "foreign", createdAt: "2000-01-01T00:00:00.000Z" };
  const raw = JSON.stringify(foreign);
  fsSync.writeFileSync(`${target}.lock`, raw);
  const lockRoot = mode.rootBound ? await root(directory) : undefined;
  const shouldReclaim = vi.fn(() => false);
  const options = {
    lockRoot, payload: () => payload, shouldReclaim, retry: { retries: 0 },
    timeoutMs: 0, staleMs: 1,
  };
  const manager = createFileLockManager(`stale-parsing:${target}`);
  await expect((async () => mode.sync
    ? acquireFileLockSync(target, options)
    : await manager.acquire(target, options))()).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(shouldReclaim).toHaveBeenCalledTimes(1);
  expect(shouldReclaim.mock.calls[0]?.[0]).toMatchObject({ payload: foreign });
  expect(fsSync.readFileSync(`${target}.lock`, "utf8")).toBe(raw);
});

it.each(modes)("$name preserves the parsed reader's filesystem observation sequence", async mode => {
  const f = await fixture(mode);
  const trace: string[] = [];
  for (const method of ["lstatSync", "fstatSync", "openSync", "readSync", "closeSync"] as const) {
    const original = fsSync[method] as (...args: unknown[]) => unknown;
    vi.spyOn(fsSync, method).mockImplementation(((...args: unknown[]) => {
      trace.push(`${method}:${typeof args[0] === "number" ? "fd" : String(args[0])}`);
      return Reflect.apply(original, fsSync, args);
    }) as never);
  }
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    trace.push(`open:${String(args[0])}`);
    const handle = await open(...args);
    for (const method of ["read", "close"] as const) {
      const original = handle[method].bind(handle) as (...args: unknown[]) => unknown;
      vi.spyOn(handle, method).mockImplementation(((...values: unknown[]) => {
        trace.push(method);
        return original(...values);
      }) as never);
    }
    return handle;
  });
  try {
    if (!mode.sync) {
      await readSidecarLockSnapshot(f.lock.lockPath, {
        lockRoot: f.lockRoot, allowDescriptorIdentityDrift: true,
      });
    } else if (mode.rootBound) {
      const held = getRootSyncHeldLocks().get(f.lock.normalizedTargetPath)!;
      readRootSidecarSnapshotSync(held.rootPath, undefined, undefined, held.rootReceipt);
    } else readSidecarLockSnapshotSync(f.lock.lockPath);
    const expected = trace.splice(0);
    expect(await f.lock.verifyStillHeld()).toBe(true);
    expect(trace).toEqual(expected);
    expect(trace.length).toBeGreaterThan(0);
  } finally {
    vi.restoreAllMocks();
    await f.lock.release();
  }
});
