import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { sidecarLockSnapshotMatches } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const originalId = 9_007_199_254_740_995n;
const replacementId = 9_007_199_254_740_996n;
const retry = { retries: 0, minTimeout: 0, maxTimeout: 0 };

afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

function project<T extends fs.Stats | fs.BigIntStats>(stat: T, component: "dev" | "ino", value: bigint): T {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
    dev: typeof stat.dev === "bigint" ? 41n : 41,
    ino: typeof stat.ino === "bigint" ? 73n : 73,
    [component]: typeof stat[component] === "bigint" ? value : Number(value),
  });
}

it.each(["dev", "ino"] as const)("refuses colliding numeric %s in no-token snapshots", component => {
  expect(Number(originalId)).toBe(Number(replacementId));
  const stat = (value: number | bigint) => ({ dev: 41n, ino: 73n, [component]: value }) as fs.BigIntStats;
  for (const raw of [undefined, "same legacy bytes"]) {
    const snapshot = (value: number | bigint) => ({ payload: null, raw, stat: stat(value) });
    expect(sidecarLockSnapshotMatches(snapshot(replacementId), snapshot(originalId))).toBe(false);
    expect(sidecarLockSnapshotMatches(snapshot(Number(replacementId)), snapshot(Number(originalId)))).toBe(false);
    expect(sidecarLockSnapshotMatches(snapshot(originalId), snapshot(originalId))).toBe(true);
  }
});

for (const synchronous of [false, true]) {
  it.each(["dev", "ino"] as const)(`preserves a successor after failed raw creation with large %s (sync=${synchronous})`, async component => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-sidecar-bigint-");
    const targetPath = path.join(directory, "state");
    const lockPath = `${targetPath}.lock`;
    const displacedPath = `${lockPath}.displaced`;
    const replacementPath = `${lockPath}.replacement`;
    fs.writeFileSync(replacementPath, "successor");
    const failure = Object.assign(new Error("injected write failure"), { code: "EIO" });
    const realFstat = fs.fstatSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    let creatorClosed = false;
    const statOptions: unknown[] = [];
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
      statOptions.push(options);
      return project(realFstat(fd, options), component, creatorClosed ? replacementId : originalId);
    }) as typeof fs.fstatSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      const stat = realLstat(candidate, options);
      if (String(candidate) !== lockPath || !stat) return stat;
      statOptions.push(options);
      return project(stat, component, replacementId);
    }) as typeof fs.lstatSync);
    const swap = () => {
      if (creatorClosed) return;
      creatorClosed = true;
      fs.renameSync(lockPath, displacedPath);
      fs.renameSync(replacementPath, lockPath);
    };
    const closed: number[] = [];
    const options = { payload: () => ({ owner: "creator" }), retry, timeoutMs: 0 };
    if (synchronous) {
      vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw failure; });
      const realClose = fs.closeSync.bind(fs);
      vi.spyOn(fs, "closeSync").mockImplementation(fd => { realClose(fd); closed.push(fd); swap(); });
      expect(() => acquireFileLockSync(targetPath, options)).toThrow(failure);
    } else {
      const realOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (!creatorClosed) vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
        const realClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          const fd = handle.fd;
          await realClose();
          closed.push(fd);
          swap();
        });
        return handle;
      });
      const manager = createSidecarLockManager(`bigint:${targetPath}`);
      await expect(manager.acquire({ targetPath, ...options })).rejects.toBe(failure);
      expect(manager.heldEntries()).toEqual([]);
    }
    expect(fs.readFileSync(lockPath, "utf8")).toBe("successor");
    expect(fs.readFileSync(displacedPath, "utf8")).toBe("");
    expect(closed).toHaveLength(2);
    for (const fd of closed) expect(() => realFstat(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(statOptions.length).toBeGreaterThanOrEqual(4);
    expect(statOptions.filter(options => (options as { bigint?: boolean } | undefined)?.bigint === true).length).toBeGreaterThanOrEqual(4);
  });
}

it.each(["dev", "ino"] as const)("reclaims an unchanged Root sidecar with a large %s", async component => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-root-sidecar-bigint-");
  const capability = await root(directory);
  const targetPath = path.join(directory, "state");
  const lockPath = `${targetPath}.lock`;
  fs.writeFileSync(lockPath, '{"createdAt":"2000-01-01T00:00:00.000Z"}\n');
  const descriptors = new Set<number>();
  const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs);
  const fstat = fs.fstatSync.bind(fs), lstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "openSync").mockImplementation(((candidate, flags, mode) => {
    const fd = open(candidate, flags, mode);
    if (String(candidate) === lockPath) descriptors.add(fd);
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { descriptors.delete(fd); close(fd); });
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
    const stat = fstat(fd, options);
    return descriptors.has(fd) ? project(stat, component, originalId) : stat;
  }) as typeof fs.fstatSync);
  vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
    const stat = lstat(candidate, options);
    return String(candidate) === lockPath && stat ? project(stat, component, originalId) : stat;
  }) as typeof fs.lstatSync);
  let approved = 0;
  const handle = acquireFileLockSync(targetPath, {
    lockRoot: capability, payload: () => ({ owner: "new" }),
    staleMs: 0, staleRecovery: "remove-if-unchanged",
    shouldRemoveStaleLock: () => { approved++; return true; },
    retry: { ...retry, retries: 1 }, timeoutMs: Infinity,
  });
  try {
    expect(approved).toBe(1);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual({ owner: "new" });
  } finally { handle.release(); }
  expect(descriptors.size).toBe(0);
  expect(fs.existsSync(lockPath)).toBe(false);
});
