import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const supportsDirectRequestedMode = process.platform === "linux" || process.platform === "darwin";

function isDirectChild(rootDir: string, name: unknown): name is string {
  return typeof name === "string" && path.dirname(name) === rootDir &&
    /^workspace-[A-Za-z0-9]{6}$/.test(path.basename(name));
}

function withUmask<T>(mode: number, run: () => T): T {
  const previous = process.umask(mode);
  try {
    return run();
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

describe.runIf(supportsDirectRequestedMode)("sync direct child descriptor admission", () => {
  it.each([0o700, 0o500, 0o1700])(
    "keeps non-eligible sync mode %o on mkdtemp",
    async (dirMode) => {
      const rootDir = await tempRoot("fs-safe-workspace-nondirect-mode-");
      const direct = vi.spyOn(fsSync, "mkdirSync");
      const mkdtemp = vi.spyOn(fsSync, "mkdtempSync");
      const workspace = tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode });
      try {
        expect(fsSync.lstatSync(workspace.dir).mode & 0o7777).toBe(dirMode);
        expect(direct.mock.calls.filter(([name]) => isDirectChild(rootDir, name))).toHaveLength(0);
        expect(mkdtemp).toHaveBeenCalledTimes(1);
      } finally {
        fsSync.chmodSync(workspace.dir, 0o700);
        expect(workspace.cleanup()).toBe("removed");
      }
    },
  );

  it("keeps async requested-mode creation on mkdtemp", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-async-nondirect-");
    const direct = vi.spyOn(fsSync, "mkdirSync");
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const workspace = await tempWorkspace({ rootDir, prefix: "workspace-", dirMode: 0o750 });
    expect(direct.mock.calls.filter(([name]) => isDirectChild(rootDir, name))).toHaveLength(0);
    expect(mkdtemp).toHaveBeenCalledTimes(1);
    expect(await workspace.cleanup()).toBe("removed");
  });

  it.each([0o720, 0o702])("rejects unsafe sync mode %o before either creator", async (dirMode) => {
    const rootDir = await tempRoot("fs-safe-workspace-unsafe-nondirect-");
    const direct = vi.spyOn(fsSync, "mkdirSync");
    const mkdtemp = vi.spyOn(fsSync, "mkdtempSync");
    expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode }))
      .toThrowError(expect.objectContaining({ code: "insecure-permissions" }));
    expect(direct.mock.calls.filter(([name]) => isDirectChild(rootDir, name))).toHaveLength(0);
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary", 0o022, 0o750, 0, 1],
    ["restrictive umask", 0o077, 0o700, 1, 2],
  ] as const)("uses the one-shot exact receipt for %s creation", async (
    _label, umask, expectedInitialMode, expectedChmods, expectedLstats,
  ) => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-receipt-");
    let child = "";
    let initialMode: number | undefined;
    let childFstats = 0;
    let childLstats = 0;
    let bigintFstats = 0;
    let bigintLstats = 0;
    let childChmods = 0;
    let fstatsAtChmod: number | undefined;
    let lstatsAtChmod: number | undefined;
    let childOpenFlags: number | undefined;
    const childFds = new Set<number>();
    let realChildIdentity: Readonly<{
      dev: bigint;
      ino: bigint;
      numericDev: number;
      numericIno: number;
    }> | undefined;
    const rememberRealChildIdentity = (stat: { dev: number | bigint; ino: number | bigint }) => {
      if (realChildIdentity || typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint") return;
      realChildIdentity = Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        numericDev: Number(stat.dev),
        numericIno: Number(stat.ino),
      });
    };
    const isRealChildIdentity = (stat: { dev: number | bigint; ino: number | bigint }) =>
      realChildIdentity !== undefined &&
      (typeof stat.dev === "bigint"
        ? stat.dev === realChildIdentity.dev
        : stat.dev === realChildIdentity.numericDev) &&
      (typeof stat.ino === "bigint"
        ? stat.ino === realChildIdentity.ino
        : stat.ino === realChildIdentity.numericIno);
    const projectChildIdentity = (stat: { dev: number | bigint; ino: number | bigint }) => {
      stat.dev = typeof stat.dev === "bigint" ? 811n : 811;
      stat.ino = typeof stat.ino === "bigint" ? 1811n : 1811;
    };
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      const result = mkdir(...args);
      if (isDirectChild(rootDir, args[0])) {
        child = args[0];
        initialMode = fsSync.statSync(child).mode & 0o7777;
      }
      return result;
    });
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (isDirectChild(rootDir, args[0])) {
        childFds.add(fd);
        if (typeof args[1] === "number") childOpenFlags = args[1];
      }
      return fd;
    });
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      const stat = fstat(fd, options);
      if (childFds.has(fd)) {
        if (supportsDirectRequestedMode) {
          rememberRealChildIdentity(stat);
          if (isRealChildIdentity(stat)) projectChildIdentity(stat);
        }
        childFstats += 1;
        if (options?.bigint === true) bigintFstats += 1;
      }
      return stat;
    });
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
      const stat = lstat(name, options);
      if (supportsDirectRequestedMode && isRealChildIdentity(stat)) projectChildIdentity(stat);
      if (name === child) {
        childLstats += 1;
        if (options?.bigint === true) bigintLstats += 1;
      }
      return stat;
    });
    const fchmod = fsSync.fchmodSync.bind(fsSync);
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (childFds.has(fd)) {
        childChmods += 1;
        fstatsAtChmod = childFstats;
        lstatsAtChmod = childLstats;
      }
      return fchmod(fd, mode);
    });
    const close = fsSync.closeSync.bind(fsSync);
    let childCloses = 0;
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      if (childFds.has(fd)) childCloses += 1;
      return close(fd);
    });
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    const workspace = withUmask(umask, () => tempWorkspaceSync({
      rootDir, prefix: "workspace-", dirMode: 0o750,
    }));
    expect(workspace.dir).toBe(child);
    expect(initialMode).toBe(expectedInitialMode);
    expect(childOpenFlags! & fsSync.constants.O_NOFOLLOW).toBe(fsSync.constants.O_NOFOLLOW);
    expect(childOpenFlags! & fsSync.constants.O_DIRECTORY).toBe(fsSync.constants.O_DIRECTORY);
    expect(childFstats).toBe(2);
    expect(childLstats).toBe(expectedLstats);
    expect(childChmods).toBe(expectedChmods);
    expect(fstatsAtChmod).toBe(expectedChmods ? 1 : undefined);
    expect(lstatsAtChmod).toBe(expectedChmods ? 1 : undefined);
    if (supportsDirectRequestedMode) {
      expect(bigintFstats).toBe(1);
      expect(bigintLstats).toBe(0);
    }
    expect(childCloses).toBe(1);
    expect(register.mock.calls.map(([name]) => name)).toEqual([child]);
    expect(workspace.cleanup()).toBe("removed");
    expect(childCloses).toBe(1);
  });

  it("rejects a replacement made from the exact descriptor observation", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-fstat-race-");
    let child = "";
    let childFd: number | undefined;
    let swapped = false;
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (isDirectChild(rootDir, args[0])) {
        child = args[0];
        childFd = fd;
      }
      return fd;
    });
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      const stat = fstat(fd, options);
      if (fd === childFd && !swapped) {
        swapped = true;
        fsSync.renameSync(child, `${child}.original`);
        fsSync.mkdirSync(child, { mode: 0o750 });
        fsSync.writeFileSync(path.join(child, "keep"), "replacement");
      }
      return stat;
    });
    const close = vi.spyOn(fsSync, "closeSync");
    const fchmod = vi.spyOn(fsSync, "fchmodSync");
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    expect(() => withUmask(0o022, () => tempWorkspaceSync({
      rootDir, prefix: "workspace-", dirMode: 0o750,
    }))).toThrowError(expect.objectContaining({ code: "path-mismatch" }));
    expect(swapped).toBe(true);
    expect(fchmod).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(close.mock.calls.filter(([fd]) => fd === childFd)).toHaveLength(1);
    expect(await fs.readFile(path.join(child, "keep"), "utf8")).toBe("replacement");
    expect(fsSync.lstatSync(`${child}.original`).isDirectory()).toBe(true);
  });

  it("treats an observed inherited special bit as requiring descriptor correction", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-special-observation-");
    let childFd: number | undefined;
    let injected = false;
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (isDirectChild(rootDir, args[0])) childFd = fd;
      return fd;
    });
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      const stat = fstat(fd, options);
      if (!injected && fd === childFd && typeof stat.mode === "bigint") {
        stat.mode |= 0o2000n;
        injected = true;
      }
      return stat;
    });
    const fchmod = fsSync.fchmodSync.bind(fsSync);
    let childChmods = 0;
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (fd === childFd) childChmods += 1;
      return fchmod(fd, mode);
    });
    const workspace = withUmask(0o022, () => tempWorkspaceSync({
      rootDir, prefix: "workspace-", dirMode: 0o750,
    }));
    expect(injected).toBe(true);
    expect(childChmods).toBe(1);
    expect(fsSync.lstatSync(workspace.dir).mode & 0o7777).toBe(0o750);
    expect(workspace.cleanup()).toBe("removed");
  });

  it.each(["identity", "fstat"] as const)(
    "closes an unadmitted child descriptor after an initial %s failure",
    async (kind) => {
      const rootDir = await tempRoot("fs-safe-workspace-direct-fstat-failure-");
      const failure = Object.assign(new Error("child fstat rejected"), { code: "EIO" });
      let child = "";
      let childFd: number | undefined;
      const open = fsSync.openSync.bind(fsSync);
      vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
        const fd = open(...args);
        if (isDirectChild(rootDir, args[0])) {
          child = args[0];
          childFd = fd;
        }
        return fd;
      });
      const fstat = fsSync.fstatSync.bind(fsSync);
      const fstatSpy = vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
        if (fd !== childFd) return fstat(fd, options);
        if (kind === "fstat") throw failure;
        const stat = fstat(fd, options);
        (stat as unknown as { dev: number; ino: number }).dev = Number(stat.dev);
        (stat as unknown as { dev: number; ino: number }).ino = Number(stat.ino);
        return stat;
      });
      const close = vi.spyOn(fsSync, "closeSync");
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      const operation = () => withUmask(0o022, () => tempWorkspaceSync({
        rootDir, prefix: "workspace-", dirMode: 0o750,
      }));
      if (kind === "fstat") expect(operation).toThrow(failure);
      else expect(operation).toThrowError(expect.objectContaining({ code: "path-mismatch" }));
      fstatSpy.mockRestore();
      expect(child).not.toBe("");
      expect(register).not.toHaveBeenCalled();
      expect(close.mock.calls.filter(([fd]) => fd === childFd)).toHaveLength(1);
      expect(() => fsSync.fstatSync(childFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      expect(fsSync.lstatSync(child).isDirectory()).toBe(true);
    },
  );

  it("preserves a child-open failure and releases parent descriptor ownership", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-direct-open-failure-");
    const failure = Object.assign(new Error("child open rejected"), { code: "EIO" });
    const parentFds = new Set<number>();
    let child = "";
    const mkdir = fsSync.mkdirSync.bind(fsSync);
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      const result = mkdir(...args);
      if (isDirectChild(rootDir, args[0])) child = args[0];
      return result;
    });
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      if (isDirectChild(rootDir, args[0])) throw failure;
      const fd = open(...args);
      if (args[0] === rootDir) parentFds.add(fd);
      return fd;
    });
    const close = fsSync.closeSync.bind(fsSync);
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      parentFds.delete(fd);
      return close(fd);
    });
    const register = vi.spyOn(cleanup, "registerTempPathForExit");
    expect(() => withUmask(0o022, () => tempWorkspaceSync({
      rootDir, prefix: "workspace-", dirMode: 0o750,
    }))).toThrow(failure);
    expect(child).not.toBe("");
    expect(register).not.toHaveBeenCalled();
    expect(parentFds).toEqual(new Set());
    expect(fsSync.lstatSync(child).isDirectory()).toBe(true);
  });
});

it.runIf(process.platform === "win32")("keeps Windows requested modes on mkdtemp", async () => {
  const rootDir = await tempRoot("fs-safe-workspace-windows-nondirect-");
  const direct = vi.spyOn(fsSync, "mkdirSync");
  const mkdtemp = vi.spyOn(fsSync, "mkdtempSync");
  const workspace = tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 });
  expect(direct.mock.calls.filter(([name]) => isDirectChild(rootDir, name))).toHaveLength(0);
  expect(mkdtemp).toHaveBeenCalledTimes(1);
  expect(workspace.cleanup()).toBe("removed");
});
