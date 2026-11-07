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
  it.each(["async", "sync", "root-sync"] as const)(
    "preserves an unverified stage and a final successor after %s persistence fails", async kind => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-stage-unknown-");
      const targetPath = path.join(directory, "state.json"), lockPath = `${targetPath}.lock`;
      const capability = kind === "root-sync" ? await root(directory) : undefined;
      Object.defineProperty(process, "platform", { value: "win32" });
      const failure = Object.assign(new Error("payload persistence failed"), { code: "EIO" });
      const replacement = serializeSidecarLockPayload({ owner: "successor" }).raw;
      const fstat = fsSync.fstatSync.bind(fsSync), lstat = fsSync.lstatSync.bind(fsSync);
      const write = fsSync.writeFileSync.bind(fsSync), openSync = fsSync.openSync.bind(fsSync);
      let stage = "", failed = false;
      const descriptors: number[] = [];
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        const stat = fstat(...args);
        return kind !== "root-sync" && stat.isFile()
          ? projectIdentity(stat, { ino: typeof stat.ino === "bigint" ? 0n : 0 }) : stat;
      });
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        return failed && String(args[0]) === stage && stat
          ? projectIdentity(stat, { ino: typeof stat.ino === "bigint" ? 0n : 0 }) : stat;
      });
      const fail = () => { failed = true; write(lockPath, replacement); throw failure; };
      if (kind === "async") {
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          stage = String(args[0]); descriptors.push(handle.fd);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(fail);
          return handle;
        });
        const manager = createSidecarLockManager(`unknown:${targetPath}`);
        await expect(manager.acquire({ targetPath, payload: () => ({}), retry, timeoutMs: 0 })).rejects.toBe(failure);
        expect(manager.heldEntries()).toEqual([]);
      } else {
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = openSync(...args);
          if (String(args[0]).includes(".fs-safe-lock-")) { stage = String(args[0]); descriptors.push(fd); }
          return fd;
        });
        vi.spyOn(fsSync, "writeFileSync").mockImplementationOnce(fail);
        expect(() => acquireFileLockSync(targetPath, {
          lockRoot: capability, payload: () => ({}), retry, timeoutMs: 0,
        })).toThrow(failure);
      }
      expect(stage).not.toBe(lockPath);
      expect(descriptors).toHaveLength(1);
      for (const fd of descriptors) expect(() => fstat(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(fsSync.readFileSync(stage, "utf8")).toBe("");
      expect(fsSync.readFileSync(lockPath, "utf8")).toBe(replacement);
    },
  );

  it("rejects unknown Root stage identity before writing, leaving the final name absent", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-root-stage-unknown-");
    const capability = await root(directory);
    Object.defineProperty(process, "platform", { value: "win32" });
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      const stat = fstat(...args);
      return stat.isFile() ? projectIdentity(stat, { ino: typeof stat.ino === "bigint" ? 0n : 0 }) : stat;
    });
    const write = vi.spyOn(fsSync, "writeFileSync");
    expect(() => acquireFileLockSync(path.join(directory, "state"), {
      lockRoot: capability, payload: () => ({}), retry, timeoutMs: 0,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(write).not.toHaveBeenCalled();
    const names = fsSync.readdirSync(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\.fs-safe-lock-.*\.tmp$/);
    expect(fsSync.readFileSync(path.join(directory, names[0]!), "utf8")).toBe("");
  });
});
