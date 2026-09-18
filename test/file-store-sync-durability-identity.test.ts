import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as durability from "../src/directory-durability.js";
import { fileStoreSync } from "../src/store.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function wideDirectoryFixture() {
  const rootDir = await tempRoot("fs-safe-sync-store-durability-identity-");
  const parent = path.join(rootDir, "parent");
  const replacement = path.join(rootDir, "replacement");
  await fs.mkdir(parent, { mode: 0o700 });
  await fs.mkdir(replacement, { mode: 0o700 });
  const originalInode = (1n << 56n) + 1n;
  const replacementInode = originalInode + 2n;
  const inodes = new Map<string, bigint>();
  let parentIdentityKey = "";
  for (const [directory, inode] of [
    [rootDir, originalInode + 16n],
    [parent, originalInode],
    [replacement, replacementInode],
  ] as const) {
    const actual = await fs.lstat(directory, { bigint: true });
    const identityKey = `${actual.dev}:${actual.ino}`;
    inodes.set(identityKey, inode);
    if (directory === parent) parentIdentityKey = identityKey;
  }
  const project = <T extends Stats | BigIntStats>(stat: T, exact: BigIntStats): T => {
    const inode = inodes.get(`${exact.dev}:${exact.ino}`);
    return inode === undefined ? stat : Object.assign(Object.create(stat), {
      ino: typeof stat.ino === "bigint" ? inode : Number(inode),
    });
  };
  const lstat = fsSync.lstatSync.bind(fsSync);
  const fstat = fsSync.fstatSync.bind(fsSync);
  let numericDirectoryReads = 0;
  // Keep actual filesystem operations and descriptors; only directory IDs are widened.
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (!stat.isDirectory()) return stat;
    if (typeof stat.ino === "number") numericDirectoryReads += 1;
    return project(stat, lstat(args[0], { bigint: true }));
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    const stat = fstat(...args);
    return stat.isDirectory() ? project(stat, fstat(args[0], { bigint: true })) : stat;
  });
  return {
    rootDir, parent, replacement, originalInode, replacementInode,
    target: path.join(parent, "value"),
    numericDirectoryReads: () => numericDirectoryReads,
    projectParentDrift: () => { inodes.set(parentIdentityKey, replacementInode); },
  };
}

describe.each([false, true])("sync store exact durability identity (private=%s)", privateMode => {
  it.each([false, true])("writes through wide directory identities with durable=%s", async durable => {
    const fixture = await wideDirectoryFixture();
    const sync = vi.spyOn(durability, "syncDirectorySync");
    const fsync = vi.spyOn(fsSync, "fsyncSync");
    const store = fileStoreSync({ rootDir: fixture.rootDir, private: privateMode, durable });

    for (const content of ["first", "replacement"]) {
      expect(store.write("parent/value", content)).toBe(fixture.target);
      expect(await fs.readFile(fixture.target, "utf8")).toBe(content);
      expect(await fs.readdir(fixture.parent)).toEqual(["value"]);
    }
    expect(sync).toHaveBeenCalledTimes(durable ? 2 : 0);
    expect(fsync.mock.calls.length > 0).toBe(durable);
    expect(fixture.numericDirectoryReads()).toBe(0);
    if (durable) {
      const receipt = sync.mock.calls[0]![0] as durability.DirectoryReceipt;
      expect(receipt.identity).toBeInstanceOf(fsSync.Stats);
      expect(receipt.identity.ino).toBe(Number(fixture.originalInode));
      expect(receipt.identity.isDirectory()).toBe(true);
      expect(typeof receipt.identity.mode).toBe("number");
      expect(receipt.identity.mtime).toBeInstanceOf(Date);
      expect(sync.mock.calls[0]![1]).toEqual({ label: "store parent" });
    }
  });

  itPosix("rejects a colliding physical replacement at directory sync without readmitting it", async () => {
    const fixture = await wideDirectoryFixture();
    const moved = path.join(fixture.rootDir, "admitted-parent");
    const sync = durability.syncDirectorySync;
    let reachedSync = false;
    const open = vi.spyOn(fsSync, "openSync");
    expect(Number(fixture.originalInode)).toBe(Number(fixture.replacementInode));
    vi.spyOn(durability, "syncDirectorySync").mockImplementation((directory, options) => {
      fsSync.renameSync(fixture.parent, moved);
      fsSync.renameSync(fixture.replacement, fixture.parent);
      reachedSync = true;
      open.mockClear();
      return sync(directory, options);
    });

    expect(() => fileStoreSync({ rootDir: fixture.rootDir, private: privateMode })
      .write("parent/value", "published before swap"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(reachedSync).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readdir(fixture.parent)).toEqual([]);
    expect(await fs.readFile(path.join(moved, "value"), "utf8")).toBe("published before swap");
    expect(await fs.readdir(moved)).toEqual(["value"]);
  });

  it("rejects projected Windows identity drift at directory sync without reopening or flushing", async () => {
    const fixture = await wideDirectoryFixture();
    const sync = durability.syncDirectorySync;
    const open = vi.spyOn(fsSync, "openSync");
    const fsync = vi.spyOn(fsSync, "fsyncSync");
    let reachedSync = false;
    expect(Number(fixture.originalInode)).toBe(Number(fixture.replacementInode));
    vi.spyOn(durability, "syncDirectorySync").mockImplementation((directory, options) => {
      // Windows cannot rename this parent while its descendant writer is open.
      // Change only the exact observation at the same post-publication boundary.
      fixture.projectParentDrift();
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      expect(fsSync.lstatSync(fixture.parent, { bigint: true }).ino).toBe(fixture.replacementInode);
      reachedSync = true;
      open.mockClear();
      fsync.mockClear();
      return sync(directory, options);
    });

    expect(() => fileStoreSync({ rootDir: fixture.rootDir, private: privateMode })
      .write("parent/value", "published before identity drift"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(reachedSync).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(fsync).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.target, "utf8")).toBe("published before identity drift");
    expect(await fs.readdir(fixture.parent)).toEqual(["value"]);
    expect(await fs.readdir(fixture.replacement)).toEqual([]);
  });
});
