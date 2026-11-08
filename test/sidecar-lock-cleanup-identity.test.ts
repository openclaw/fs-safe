import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import {
  removeSidecarLockIfUnchanged,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
} from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const retry = { retries: 0, minTimeout: 0, maxTimeout: 0 };

function identityStat(dev: number, ino: number): Stats {
  return { dev, ino, isFile: () => true } as Stats;
}

function projectIdentity<T extends Stats | BigIntStats>(stat: T, identity: { dev?: T["dev"]; ino?: T["ino"] }): T {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, identity) as T;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

describe("sidecar no-token cleanup identity", () => {
  const known = [41, 73] as const;
  const unknownCases = [
    ["observed device", [0, 73], known],
    ["observed inode", [41, 0], known],
    ["observed device and inode", [0, 0], known],
    ["current device", known, [0, 73]],
    ["current inode", known, [41, 0]],
    ["current device and inode", known, [0, 0]],
    ["both devices", [0, 73], [0, 73]],
    ["both inodes", [41, 0], [41, 0]],
    ["both complete identities", [0, 0], [0, 0]],
    ["opposite components", [0, 73], [41, 0]],
  ] as const;

  it.each(unknownCases)(
    "rejects an unknown Windows %s in stat-only and stat-plus-raw receipts",
    (_label, [observedDev, observedIno], [currentDev, currentIno]) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const observed: SidecarLockSnapshot = {
        payload: null,
        stat: identityStat(observedDev, observedIno),
      };
      const current: SidecarLockSnapshot = {
        payload: null,
        stat: identityStat(currentDev, currentIno),
      };

      expect(sidecarLockSnapshotMatches(current, observed)).toBe(false);
      expect(sidecarLockSnapshotMatches(
        { ...current, raw: "same legacy bytes" },
        { ...observed, raw: "same legacy bytes" },
      )).toBe(false);
    },
  );

  it("retains known identity and raw-only legacy comparison behavior", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const first = identityStat(41, 73);
    const differentDevice = identityStat(42, 73);
    const differentInode = identityStat(41, 74);

    expect(sidecarLockSnapshotMatches(
      { payload: null, stat: first },
      { payload: null, stat: first },
    )).toBe(true);
    expect(sidecarLockSnapshotMatches(
      { payload: null, stat: differentDevice },
      { payload: null, stat: first },
    )).toBe(false);
    expect(sidecarLockSnapshotMatches(
      { payload: null, stat: differentInode },
      { payload: null, stat: first },
    )).toBe(false);
    expect(sidecarLockSnapshotMatches(
      { payload: null, stat: first, raw: "same" },
      { payload: null, stat: first, raw: "same" },
    )).toBe(true);
    expect(sidecarLockSnapshotMatches(
      { payload: null, stat: differentInode, raw: "same" },
      { payload: null, stat: first, raw: "same" },
    )).toBe(false);
    expect(sidecarLockSnapshotMatches(
      { payload: null, raw: "same" },
      { payload: null, raw: "same" },
    )).toBe(true);
    expect(sidecarLockSnapshotMatches(
      { payload: null, raw: "changed" },
      { payload: null, raw: "same" },
    )).toBe(false);
  });

  it("retains token authority when the current Windows identity is unknown", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const serialized = serializeSidecarLockPayload({ owner: "token" });
    const observed: SidecarLockSnapshot = {
      payload: null,
      raw: serialized.raw,
      ownershipToken: serialized.ownershipToken,
    };

    expect(sidecarLockSnapshotMatches({
      payload: null,
      raw: serialized.raw,
      stat: identityStat(0, 0),
    }, observed)).toBe(true);
    expect(sidecarLockSnapshotMatches({
      payload: null,
      raw: `${serialized.raw}changed`,
      stat: identityStat(0, 0),
    }, observed)).toBe(false);
  });

  it("retains token-authorized removal through a Root capability", async () => {
    const directory = await tempRoot("fs-safe-sidecar-cleanup-root-token-");
    const capability = await root(directory);
    const relative = "state.lock";
    const lockPath = path.join(directory, relative);
    const serialized = serializeSidecarLockPayload({ owner: "root" });
    await capability.create(relative, serialized.raw);
    const realOpen = capability.open.bind(capability);
    const openedHandles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
    vi.spyOn(capability, "open").mockImplementation(async (...args) => {
      const opened = await realOpen(...args);
      openedHandles.push(opened.handle);
      opened.stat = projectIdentity(opened.stat, { dev: 0, ino: 0 });
      return opened;
    });

    await expect(removeSidecarLockIfUnchanged(lockPath, {
      payload: null,
      raw: serialized.raw,
      ownershipToken: serialized.ownershipToken,
    }, { lockRoot: capability })).resolves.toBe(true);

    expect(openedHandles).toHaveLength(1);
    expect(openedHandles[0]?.fd).toBe(-1);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("failed sidecar creation with unknown Windows identity", () => {
  it("preserves the async pathname and original error while closing both handles", async () => {
    const directory = await tempRoot("fs-safe-sidecar-cleanup-async-unknown-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const displacedPath = `${lockPath}.failed-create`;
    const replacementPath = `${lockPath}.replacement`;
    const replacement = serializeSidecarLockPayload({ owner: "replacement" }).raw;
    await fs.writeFile(replacementPath, replacement);
    const failure = Object.assign(new Error("payload persistence failed"), {
      code: "EIO",
      path: lockPath,
      syscall: "write",
    });
    configureFsSafeNative({ mode: "off" });
    Object.defineProperty(process, "platform", { value: "win32" });
    const realFstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) =>
      projectIdentity(realFstat(fd), { ino: 0 }));
    const realOpen = fs.open.bind(fs);
    const openedHandles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      openedHandles.push(handle);
      if (openedHandles.length === 1) {
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
        const realClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          await realClose();
          await fs.rename(lockPath, displacedPath);
          await fs.rename(replacementPath, lockPath);
        });
      }
      return handle;
    });
    const manager = createSidecarLockManager(`cleanup-unknown:${targetPath}`);

    await expect(manager.acquire({
      targetPath,
      payload: async () => ({ owner: "async" }),
      retry,
      timeoutMs: 0,
    })).rejects.toBe(failure);

    expect(openedHandles).toHaveLength(2);
    expect(openedHandles.map(({ fd }) => fd)).toEqual([-1, -1]);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("");
    expect(manager.heldEntries()).toEqual([]);
  });

  it("preserves the raw sync pathname and original error while closing both handles", async () => {
      const directory = await tempRoot("fs-safe-sidecar-cleanup-sync-unknown-");
      const targetPath = path.join(directory, "state.json");
      const lockPath = `${targetPath}.lock`;
      const displacedPath = `${lockPath}.failed-create`;
      const replacementPath = `${lockPath}.replacement`;
      const replacement = serializeSidecarLockPayload({ owner: "replacement" }).raw;
      fsSync.writeFileSync(replacementPath, replacement);
      const failure = Object.assign(new Error("payload persistence failed"), {
        code: "EIO",
        path: lockPath,
        syscall: "write",
      });
      Object.defineProperty(process, "platform", { value: "win32" });
      const realFstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) =>
        projectIdentity(realFstat(fd), { ino: 0 }));
      vi.spyOn(fsSync, "writeFileSync").mockImplementationOnce(() => { throw failure; });
      const open = vi.spyOn(fsSync, "openSync");
      const realClose = fsSync.closeSync.bind(fsSync);
      let closed = 0;
      const close = vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
        realClose(fd);
        if (closed++ === 0) {
          fsSync.renameSync(lockPath, displacedPath);
          fsSync.renameSync(replacementPath, lockPath);
        }
      });
      const remove = vi.spyOn(fsSync, "rmSync");

      let caught: unknown;
      try {
        acquireFileLockSync(targetPath, {
          payload: () => ({ owner: "sync" }),
          retry,
          timeoutMs: 0,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(open).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
      expect(remove).not.toHaveBeenCalled();
      for (const [fd] of close.mock.calls) {
        expect(() => realFstat(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      }
      expect(fsSync.readFileSync(lockPath, "utf8")).toBe(replacement);
      expect(fsSync.readFileSync(displacedPath, "utf8")).toBe("");
  });

  it("preserves a Root write failure and an ambiguous cleanup receipt without deleting the successor", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-root-cleanup-unknown-");
    const capability = await root(directory);
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const displacedPath = `${lockPath}.failed-create`;
    const replacementPath = `${lockPath}.replacement`;
    const replacement = serializeSidecarLockPayload({ owner: "successor" }).raw;
    fsSync.writeFileSync(replacementPath, replacement);
    const failure = Object.assign(new Error("payload persistence failed"), { code: "EIO" });
    Object.defineProperty(process, "platform", { value: "win32" });
    const realFstat = fsSync.fstatSync.bind(fsSync);
    const realLstat = fsSync.lstatSync.bind(fsSync);
    let closedCreator = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = realLstat(...args);
      return closedCreator && String(args[0]) === lockPath && stat && typeof stat.ino === "bigint"
        ? projectIdentity(stat, { ino: 0n }) : stat;
    });
    const write = vi.spyOn(fsSync, "writeFileSync").mockImplementationOnce(() => { throw failure; });
    const open = vi.spyOn(fsSync, "openSync");
    const realClose = fsSync.closeSync.bind(fsSync);
    const close = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      realClose(fd);
      closedCreator = true;
      fsSync.renameSync(lockPath, displacedPath);
      fsSync.renameSync(replacementPath, lockPath);
    });
    const remove = vi.spyOn(fsSync, "unlinkSync");
    let caught: unknown;
    try {
      acquireFileLockSync(targetPath, {
        lockRoot: capability, payload: () => ({ owner: "sync" }), retry, timeoutMs: 0,
      });
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "SuppressedError", error: failure, suppressed: { code: "path-mismatch" } });
    expect((caught as { error: unknown }).error).toBe(failure);
    expect(write).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(() => realFstat(close.mock.calls[0]![0])).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fsSync.readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(fsSync.readFileSync(displacedPath, "utf8")).toBe("");
  });

  it("rejects unknown Root creator identity before writing and leaves the unverified path untouched", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-root-create-unknown-");
    const capability = await root(directory);
    const targetPath = path.join(directory, "state.json");
    Object.defineProperty(process, "platform", { value: "win32" });
    const realFstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      const stat = realFstat(...args);
      return typeof stat.ino === "bigint" ? projectIdentity(stat, { ino: 0n }) : stat;
    });
    const write = vi.spyOn(fsSync, "writeFileSync");
    const open = vi.spyOn(fsSync, "openSync");
    const close = vi.spyOn(fsSync, "closeSync");
    const remove = vi.spyOn(fsSync, "unlinkSync");
    expect(() => acquireFileLockSync(targetPath, {
      lockRoot: capability, payload: () => ({ owner: "sync" }), retry, timeoutMs: 0,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(write).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(() => realFstat(close.mock.calls[0]![0])).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fsSync.readFileSync(`${targetPath}.lock`, "utf8")).toBe("");
  });
});
