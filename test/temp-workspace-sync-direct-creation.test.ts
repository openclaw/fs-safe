import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { tempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { TempWorkspaceCleanupCapability } from "../src/temp-workspace-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function isDirectChild(rootDir: string, name: unknown): name is string {
  return typeof name === "string" && path.dirname(name) === rootDir &&
    /^workspace-[A-Za-z0-9]{6}$/.test(path.basename(name));
}

function collision(): NodeJS.ErrnoException {
  return Object.assign(new Error("temp workspace name collision"), { code: "EEXIST" });
}

function tempWorkspaceSyncWithUmask022(options: Parameters<typeof tempWorkspaceSync>[0]) {
  const previous = process.umask(0o022);
  try {
    return tempWorkspaceSync(options);
  } finally {
    process.umask(previous);
  }
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.runIf(process.platform === "linux")("sync requested-mode direct creation", () => {
  it("retries an exclusive collision without inspecting, adopting, or cleaning its winner", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-collision-");
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    const directPaths: string[] = [];
    let winner = "";
    let successfulInitialMode: number | undefined;
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      if (!isDirectChild(rootDir, args[0])) return mkdir(...args);
      directPaths.push(args[0]);
      const result = mkdir(...args);
      if (directPaths.length === 1) {
        winner = args[0];
        fsSync.writeFileSync(path.join(winner, "keep"), "collision winner");
        throw collision();
      }
      successfulInitialMode = fsSync.statSync(args[0]).mode & 0o7777;
      return result;
    });
    const lstat = fsSync.lstatSync.bind(fsSync);
    const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => lstat(...args));
    const open = fsSync.openSync.bind(fsSync);
    const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((...args) => open(...args));
    const fchmod = vi.spyOn(fsSync, "fchmodSync");
    const prepare = vi.spyOn(TempWorkspaceCleanupCapability.prototype, "prepareChildCreation");
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    const workspace = tempWorkspaceSyncWithUmask022({
      rootDir, prefix: "workspace-", dirMode: 0o750,
    });
    expect(directPaths.length).toBeGreaterThanOrEqual(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(successfulInitialMode).toBeDefined();
    expect(workspace.dir).toBe(directPaths.at(-1));
    expect(workspace.dir).not.toBe(winner);
    expect(lstatSpy.mock.calls.filter(([name]) => name === winner)).toHaveLength(0);
    expect(openSpy.mock.calls.filter(([name]) => name === winner)).toHaveLength(0);
    expect(fchmod).toHaveBeenCalledTimes(successfulInitialMode === 0o750 ? 0 : 1);
    expect(fsSync.statSync(workspace.dir).mode & 0o7777).toBe(0o750);
    expect(register.mock.calls.map(([name]) => name)).toEqual([workspace.dir]);
    expect(workspace.cleanup()).toBe("removed");
    expect(await fs.readFile(path.join(winner, "keep"), "utf8")).toBe("collision winner");
  });

  it("bounds collisions and releases every provisional descriptor without adoption", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-exhausted-");
    const retainedRootFds = new Set<number>();
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === rootDir) retainedRootFds.add(fd);
      return fd;
    });
    const close = fsSync.closeSync.bind(fsSync);
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      retainedRootFds.delete(fd);
      return close(fd);
    });
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    const directPaths: string[] = [];
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      if (!isDirectChild(rootDir, args[0])) return mkdir(...args);
      directPaths.push(args[0]);
      throw collision();
    });
    const prepare = vi.spyOn(TempWorkspaceCleanupCapability.prototype, "prepareChildCreation");
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    const fchmod = vi.spyOn(fsSync, "fchmodSync");
    expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 }))
      .toThrowError(expect.objectContaining({ code: "EEXIST" }));
    expect(directPaths).toHaveLength(64);
    expect(prepare).toHaveBeenCalledTimes(64);
    expect(register).not.toHaveBeenCalled();
    expect(fchmod).not.toHaveBeenCalled();
    expect(retainedRootFds).toEqual(new Set());
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("preserves a direct-create failure and releases provisional descriptor ownership", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-failure-");
    const retainedRootFds = new Set<number>();
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === rootDir) retainedRootFds.add(fd);
      return fd;
    });
    const close = fsSync.closeSync.bind(fsSync);
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      retainedRootFds.delete(fd);
      return close(fd);
    });
    const failure = Object.assign(new Error("mkdir rejected"), { code: "EIO" });
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    let directCreates = 0;
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      if (!isDirectChild(rootDir, args[0])) return mkdir(...args);
      directCreates += 1;
      throw failure;
    });
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 }))
      .toThrow(failure);
    expect(directCreates).toBe(1);
    expect(register).not.toHaveBeenCalled();
    expect(retainedRootFds).toEqual(new Set());
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("rechecks the full parent fence after a collision and rejects replacement", async () => {
    const base = await tempRoot("fs-safe-workspace-direct-retry-parent-");
    const rootDir = path.join(base, "root");
    const originalRoot = path.join(base, "root-original");
    await fs.mkdir(rootDir, { mode: 0o700 });
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    let winner = "";
    let directCreates = 0;
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      if (!isDirectChild(rootDir, args[0])) return mkdir(...args);
      directCreates += 1;
      winner = args[0];
      mkdir(...args);
      fsSync.writeFileSync(path.join(winner, "keep"), "collision winner");
      fsSync.renameSync(rootDir, originalRoot);
      mkdir(rootDir, { mode: 0o700 });
      throw collision();
    });
    const prepare = vi.spyOn(TempWorkspaceCleanupCapability.prototype, "prepareChildCreation");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const fchmod = vi.spyOn(fsSync, "fchmodSync");
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 }))
      .toThrowError(expect.objectContaining({ code: "path-mismatch" }));
    expect(directCreates).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(lstat.mock.calls.filter(([name]) => name === winner)).toHaveLength(0);
    expect(fchmod).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
    expect(await fs.readFile(path.join(originalRoot, path.basename(winner), "keep"), "utf8"))
      .toBe("collision winner");
  });

  it("rejects replaced ancestry even when the leaf root inode is preserved", async () => {
    const base = await tempRoot("fs-safe-workspace-direct-retry-ancestor-");
    const ancestor = path.join(base, "ancestor");
    const originalAncestor = path.join(base, "ancestor-original");
    const rootDir = path.join(ancestor, "root");
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const rootIdentity = await fs.stat(rootDir, { bigint: true });
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    let winner = "";
    let directCreates = 0;
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      if (!isDirectChild(rootDir, args[0])) return mkdir(...args);
      directCreates += 1;
      winner = args[0];
      mkdir(...args);
      fsSync.writeFileSync(path.join(winner, "keep"), "collision winner");
      fsSync.renameSync(ancestor, originalAncestor);
      fsSync.symlinkSync(originalAncestor, ancestor, "dir");
      throw collision();
    });
    const prepare = vi.spyOn(TempWorkspaceCleanupCapability.prototype, "prepareChildCreation");
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 }))
      .toThrowError(expect.objectContaining({ code: "path-mismatch" }));
    const currentRoot = await fs.stat(rootDir, { bigint: true });
    expect(currentRoot.dev).toBe(rootIdentity.dev);
    expect(currentRoot.ino).toBe(rootIdentity.ino);
    expect(directCreates).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(register).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(winner, "keep"), "utf8")).toBe("collision winner");
  });

  it.each([
    ["owner", "not-owned"],
    ["mode", "insecure-permissions"],
    ["descriptor", "path-mismatch"],
  ] as const)("rejects a replayed parent %s mismatch", async (kind, code) => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-retry-security-");
    const open = fsSync.openSync.bind(fsSync);
    let parentFd: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === rootDir) parentFd = fd;
      return fd;
    });
    let replay = false;
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
      const stat = lstat(name, options);
      if (!replay || name !== rootDir) return stat;
      if (kind === "owner") {
        (stat as { uid: number | bigint }).uid = typeof stat.uid === "bigint"
          ? BigInt(process.geteuid!()) + 1n
          : process.geteuid!() + 1;
      } else if (kind === "mode") {
        (stat as { mode: number | bigint }).mode = typeof stat.mode === "bigint"
          ? stat.mode | 0o022n
          : stat.mode | 0o022;
      }
      return stat;
    });
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      const stat = fstat(fd, options);
      if (replay && kind === "descriptor" && fd === parentFd) {
        (stat as { ino: number | bigint }).ino = typeof stat.ino === "bigint"
          ? stat.ino + 1n
          : stat.ino + 1;
      }
      return stat;
    });
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    let winner = "";
    let directCreates = 0;
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      if (!isDirectChild(rootDir, args[0])) return mkdir(...args);
      directCreates += 1;
      winner = args[0];
      mkdir(...args);
      fsSync.writeFileSync(path.join(winner, "keep"), "collision winner");
      replay = true;
      throw collision();
    });
    const prepare = vi.spyOn(TempWorkspaceCleanupCapability.prototype, "prepareChildCreation");
    const close = vi.spyOn(fsSync, "closeSync");
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 }))
      .toThrowError(expect.objectContaining({ code }));
    expect(parentFd).toBeDefined();
    expect(directCreates).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(close.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
    expect(register).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(winner, "keep"), "utf8")).toBe("collision winner");
  });
});
