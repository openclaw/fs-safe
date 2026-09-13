import type { Stats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathExists, pathExistsSync } from "../src/fs.js";
import { mkdirPathComponentsWithGuards } from "../src/guarded-mkdir.js";
import {
  isPathInside,
  isPathInsideWithRealpath,
  safeRealpathSync,
  safeStatSync,
} from "../src/path.js";
import {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
} from "../src/symlink-parents.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function simulateWindows(): void {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("Windows namespace-alias guard boundaries", () => {
  it("rejects direct symlink-parent aliases before I/O or allowOutsideRoot return", async () => {
    simulateWindows();
    const rootDir = path.resolve("symlink-parent-root");
    const targetPath = path.join(rootDir, "child");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    let targetReads = 0;

    await expect(assertNoSymlinkParents({
      rootDir: `${rootDir}:payload`,
      get targetPath() {
        targetReads += 1;
        return path.resolve("outside");
      },
      allowOutsideRoot: true,
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(() => assertNoSymlinkParentsSync({
      rootDir,
      targetPath: `${targetPath}:payload`,
      allowMissing: true,
    })).toThrow(expect.objectContaining({ code: "invalid-path" }));
    expect(targetReads).toBe(0);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("snapshots direct symlink-parent root and target inputs once", async () => {
    const rootDir = await tempRoot("fs-safe-ads-parent-snapshot-");
    simulateWindows();

    for (const run of [
      (params: Parameters<typeof assertNoSymlinkParents>[0]) => assertNoSymlinkParents(params),
      async (params: Parameters<typeof assertNoSymlinkParentsSync>[0]) => {
        assertNoSymlinkParentsSync(params);
      },
    ]) {
      let rootReads = 0;
      let targetReads = 0;
      const params = {
        get rootDir() {
          rootReads += 1;
          return rootReads === 1 ? rootDir : `${rootDir}:payload`;
        },
        get targetPath() {
          targetReads += 1;
          return targetReads === 1 ? rootDir : `${rootDir}:payload`;
        },
      };
      await expect(run(params)).resolves.toBeUndefined();
      expect({ rootReads, targetReads }).toEqual({ rootReads: 1, targetReads: 1 });
    }
  });

  it("fails canonical containment closed for raw, cached, and realpath aliases", () => {
    simulateWindows();
    const basePath = "C:\\safe";
    const candidatePath = "C:\\safe\\child.txt";
    const aliasPath = `${candidatePath}:payload`;
    const realpath = vi.spyOn(fsSync, "realpathSync");

    expect(isPathInsideWithRealpath(basePath, aliasPath, { requireRealpath: false })).toBe(false);
    expect(realpath).not.toHaveBeenCalled();

    const cache = new Map([
      [basePath, basePath],
      [candidatePath, aliasPath],
    ]);
    expect(isPathInsideWithRealpath(basePath, candidatePath, {
      cache,
      requireRealpath: false,
    })).toBe(false);
    expect(realpath).not.toHaveBeenCalled();

    cache.delete(basePath);
    realpath.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(isPathInsideWithRealpath(basePath, candidatePath, {
      cache,
      requireRealpath: false,
    })).toBe(false);

    realpath.mockImplementation((input) => String(input) === candidatePath ? aliasPath : basePath);
    expect(isPathInsideWithRealpath(basePath, candidatePath, { requireRealpath: false })).toBe(false);

    realpath.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(isPathInsideWithRealpath(basePath, candidatePath, { requireRealpath: false })).toBe(true);
  });

  it("keeps lexical containment and ordinary stat/existence wrappers non-admitting", async () => {
    simulateWindows();
    const aliasPath = "C:\\safe\\child.txt:payload";
    const fakeStat = { isFile: () => true } as Stats;
    const realpath = vi.spyOn(fsSync, "realpathSync").mockReturnValue(aliasPath);
    const stat = vi.spyOn(fsSync, "statSync").mockReturnValue(fakeStat);

    expect(isPathInside("C:\\safe", aliasPath)).toBe(true);
    expect(safeRealpathSync(aliasPath)).toBe(aliasPath);
    expect(safeStatSync(aliasPath)).toBe(fakeStat);
    await expect(pathExists(aliasPath)).resolves.toBe(true);
    expect(pathExistsSync(aliasPath)).toBe(true);
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(3);
  });

  it("rejects guarded-mkdir raw aliases before realpath, callbacks, or mutation", async () => {
    simulateWindows();
    const rootDir = path.resolve("guarded-mkdir-root");
    const targetPath = path.join(rootDir, "child");
    const realpath = vi.spyOn(fsSync.realpathSync, "native");
    const beforeComponent = vi.fn();
    let targetReads = 0;

    await expect(mkdirPathComponentsWithGuards({
      rootReal: `${rootDir}:payload`,
      get targetPath() {
        targetReads += 1;
        return targetPath;
      },
      beforeComponent,
    })).rejects.toMatchObject({ code: "invalid-path" });
    await expect(mkdirPathComponentsWithGuards({
      rootReal: rootDir,
      targetPath: `${targetPath}:payload`,
      beforeComponent,
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(targetReads).toBe(0);
    expect(realpath).not.toHaveBeenCalled();
    expect(beforeComponent).not.toHaveBeenCalled();
  });

  it("snapshots guarded-mkdir root and target inputs once", async () => {
    const rootDir = await tempRoot("fs-safe-ads-mkdir-snapshot-");
    simulateWindows();
    let rootReads = 0;
    let targetReads = 0;

    await expect(mkdirPathComponentsWithGuards({
      get rootReal() {
        rootReads += 1;
        return rootReads === 1 ? rootDir : `${rootDir}:payload`;
      },
      get targetPath() {
        targetReads += 1;
        return targetReads === 1 ? rootDir : `${rootDir}:payload`;
      },
    })).resolves.toBe(path.resolve(rootDir));
    expect({ rootReads, targetReads }).toEqual({ rootReads: 1, targetReads: 1 });
  });

  it("rejects guarded-mkdir canonical root and parent aliases before mutation", async () => {
    const rootDir = await tempRoot("fs-safe-ads-mkdir-canonical-");
    const child = path.join(rootDir, "child");
    simulateWindows();
    const beforeComponent = vi.fn();

    vi.spyOn(fsSync.realpathSync, "native").mockReturnValue(`${rootDir}:payload`);
    await expect(mkdirPathComponentsWithGuards({
      rootReal: rootDir,
      targetPath: child,
      beforeComponent,
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(beforeComponent).not.toHaveBeenCalled();
    await expect(fs.stat(child)).rejects.toMatchObject({ code: "ENOENT" });

    vi.restoreAllMocks();
    let realpathCalls = 0;
    vi.spyOn(fsSync.realpathSync, "native").mockImplementation(() => {
      realpathCalls += 1;
      return realpathCalls === 1 ? rootDir : `${rootDir}:payload`;
    });
    await expect(mkdirPathComponentsWithGuards({
      rootReal: rootDir,
      targetPath: child,
      beforeComponent,
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(beforeComponent).not.toHaveBeenCalled();
    await expect(fs.stat(child)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a canonical component alias before descending further", async () => {
    const rootDir = await tempRoot("fs-safe-ads-mkdir-component-");
    const first = path.join(rootDir, "first");
    const second = path.join(first, "second");
    simulateWindows();
    const beforeComponent = vi.fn();

    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((input) => (
      path.resolve(String(input)) === first ? `${first}:payload` : rootDir
    ));
    await expect(mkdirPathComponentsWithGuards({
      rootReal: rootDir,
      targetPath: second,
      beforeComponent,
    })).rejects.toMatchObject({ code: "invalid-path" });
    expect(beforeComponent).toHaveBeenCalledTimes(1);
    expect((await fs.stat(first)).isDirectory()).toBe(true);
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

itPosix("preserves POSIX colon paths across guards, containment, and probes", async () => {
  const rootDir = await tempRoot("fs-safe-posix-colon-guards-");
  const colonDir = path.join(rootDir, "scope:stable");
  const nested = path.join(colonDir, "child:next");
  await fs.mkdir(colonDir);

  await expect(assertNoSymlinkParents({
    rootDir,
    targetPath: colonDir,
    allowMissing: false,
  })).resolves.toBeUndefined();
  expect(() => assertNoSymlinkParentsSync({
    rootDir,
    targetPath: colonDir,
    allowMissing: false,
  })).not.toThrow();
  await expect(mkdirPathComponentsWithGuards({
    rootReal: rootDir,
    targetPath: nested,
  })).resolves.toBe(nested);
  expect(isPathInsideWithRealpath(rootDir, nested)).toBe(true);
  expect(safeRealpathSync(nested)).toBe(nested);
  expect(safeStatSync(nested)?.isDirectory()).toBe(true);
  await expect(pathExists(nested)).resolves.toBe(true);
  expect(pathExistsSync(nested)).toBe(true);
});
