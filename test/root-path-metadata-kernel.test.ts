import { spawnSync } from "node:child_process";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as canonical from "../src/realpath.js";
import { resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import {
  resolveRootPath,
  resolveRootPathSync,
  resolveRootPathSyncWithCanonicalRootObservation,
  resolveRootPathWithCanonicalRootObservation,
} from "../src/root-path.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

itPosix("preserves kernel expansion of raw parent segments inside symlink targets", async () => {
  const rootPath = await tempRoot("fs-safe-root-metadata-parent-");
  const target = path.join(rootPath, "target");
  fs.mkdirSync(path.join(target, "child"), { recursive: true });
  fs.symlinkSync("target/child", path.join(rootPath, "link"), "dir");
  const absolutePath = path.join(rootPath, "indirect");
  fs.symlinkSync("link/..", absolutePath, "dir");
  const params = { rootPath, absolutePath, boundaryLabel: "fixture" };
  await expect(resolveRootPath(params)).resolves.toMatchObject({ canonicalPath: target, exists: true, kind: "directory" });
  expect(resolveRootPathSync(params)).toMatchObject({ canonicalPath: target, exists: true, kind: "directory" });
});

itPosix.each([true, false])("rejects a symlink whose parent segment escapes through another symlink (existing=%s)", async exists => {
  const base = await tempRoot("fs-safe-root-metadata-escape-");
  const rootPath = path.join(base, "root");
  const outside = path.join(base, "outside", "a");
  fs.mkdirSync(rootPath);
  fs.mkdirSync(path.join(outside, "b"), { recursive: true });
  if (exists) fs.writeFileSync(path.join(outside, "x"), "outside");
  fs.writeFileSync(path.join(rootPath, "x"), "decoy");
  fs.symlinkSync(path.join(outside, "b"), path.join(rootPath, "s"), "dir");
  const absolutePath = path.join(rootPath, "link");
  fs.symlinkSync("s/../x", absolutePath);
  if (exists) expect(fs.readFileSync(absolutePath, "utf8")).toBe("outside");
  else expect(fs.existsSync(absolutePath)).toBe(false);
  const params = { rootPath, absolutePath, boundaryLabel: "fixture" };
  await expect(resolveRootPath(params)).rejects.toThrow(/Symlink escapes/);
  expect(() => resolveRootPathSync(params)).toThrow();
  expect(resolveLocalPathFromRootsSync({ roots: [rootPath], filePath: absolutePath })).toBeNull();
});

itPosix.each(["async", "sync"] as const)("%s keeps a missing target below its physical symlink parent", async mode => {
  const rootPath = await tempRoot("fs-safe-root-metadata-missing-");
  const target = path.join(rootPath, "target");
  fs.mkdirSync(path.join(target, "child"), { recursive: true });
  fs.symlinkSync("target/child", path.join(rootPath, "first"), "dir");
  const absolutePath = path.join(rootPath, "indirect");
  fs.symlinkSync("first/../missing", absolutePath);
  const resolve = mode === "async" ? resolveRootPath : resolveRootPathSync;
  await expect(Promise.resolve(resolve({ rootPath, absolutePath, boundaryLabel: "fixture" })))
    .resolves.toMatchObject({ canonicalPath: path.join(target, "missing"), exists: false });
});

itPosix.each(["async", "sync"] as const)("%s rejects a parent step after an unresolved symlink target component", async mode => {
  const rootPath = await tempRoot("fs-safe-root-metadata-unresolved-");
  fs.writeFileSync(path.join(rootPath, "decoy"), "decoy");
  const absolutePath = path.join(rootPath, "link");
  fs.symlinkSync("missing/../decoy", absolutePath);
  const resolve = mode === "async" ? resolveRootPath : resolveRootPathSync;
  await expect(Promise.resolve().then(() => resolve({ rootPath, absolutePath, boundaryLabel: "fixture" })))
    .rejects.toMatchObject({ code: "symlink" });
});

itPosix.each(["async", "sync"] as const)("%s resolves a chain of dangling symlinks", async mode => {
  const rootPath = await tempRoot("fs-safe-root-metadata-dangling-chain-");
  fs.symlinkSync("missing", path.join(rootPath, "middle"));
  const absolutePath = path.join(rootPath, "outer");
  fs.symlinkSync("middle", absolutePath);
  const resolve = mode === "async" ? resolveRootPath : resolveRootPathSync;
  await expect(Promise.resolve().then(() => resolve({ rootPath, absolutePath, boundaryLabel: "fixture" })))
    .resolves.toMatchObject({ canonicalPath: path.join(rootPath, "missing"), exists: false, kind: "missing" });
});

it.each(["async", "sync"] as const)(
  "%s uses kernel canonicalization for roots, symlinks, and missing symlink targets",
  async mode => {
    const rootPath = await tempRoot("fs-safe-root-metadata-route-");
    const target = path.join(rootPath, "target");
    const link = path.join(rootPath, "link");
    const dangling = path.join(rootPath, "dangling");
    const missing = path.join(rootPath, "future", "leaf");
    fs.mkdirSync(target);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(target, link, linkType);
    fs.symlinkSync(missing, dangling, linkType);
    const calls: string[] = [];
    if (mode === "async" && process.platform !== "win32") {
      const actual = canonical.realpathNative;
      vi.spyOn(canonical, "realpathNative").mockImplementation(candidate => {
        calls.push(candidate);
        return actual(candidate);
      });
    } else {
      const actual = canonical.realpathSync.native;
      vi.spyOn(canonical.realpathSync, "native").mockImplementation(candidate => {
        calls.push(candidate);
        return actual(candidate);
      });
    }
    const resolve = mode === "async" ? resolveRootPath : resolveRootPathSync;
    await expect(Promise.resolve(resolve({
      rootPath, absolutePath: link, boundaryLabel: "fixture",
    }))).resolves.toMatchObject({ canonicalPath: target, exists: true, kind: "directory" });
    expect(calls).toEqual([rootPath, link]);
    calls.length = 0;
    await expect(Promise.resolve(resolve({
      rootPath, absolutePath: dangling, boundaryLabel: "fixture",
    }))).resolves.toMatchObject({ canonicalPath: missing, exists: false, kind: "missing" });
    expect(calls).toEqual([rootPath, dangling, rootPath]);
  },
);

it("keeps strict native existence errors separate from ordinary existsSync", async () => {
  const rootPath = await tempRoot("fs-safe-root-metadata-existence-");
  const params = { rootPath, absolutePath: rootPath, boundaryLabel: "fixture" };
  const failure = Object.assign(new Error("synthetic metadata denial"), { code: "EACCES" });
  if (process.platform === "win32") {
    const actual = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      if (candidate === rootPath) throw failure;
      return actual(candidate, options);
    }) as typeof fs.lstatSync);
  } else {
    const actual = asyncFs.lstat.bind(asyncFs);
    vi.spyOn(asyncFs, "lstat").mockImplementation((async (candidate, options) => {
      if (candidate === rootPath) throw failure;
      return actual(candidate, options);
    }) as typeof asyncFs.lstat);
  }
  const exists = vi.spyOn(fs, "existsSync");
  await expect(resolveRootPath(params)).rejects.toBe(failure);
  expect(exists).not.toHaveBeenCalled();
  expect(resolveRootPathSync(params)).toMatchObject({ canonicalPath: rootPath, exists: true, kind: "directory" });
  expect(exists).toHaveBeenCalledWith(rootPath);
});

it.each(["async", "sync"] as const)(
  "%s observes the canonical root before inspecting target components",
  async mode => {
    const rootPath = await tempRoot("fs-safe-root-metadata-order-");
    const target = path.join(rootPath, "value");
    fs.writeFileSync(target, "value");
    const order: string[] = [];
    if (mode === "async" && process.platform !== "win32") {
      const actual = asyncFs.lstat.bind(asyncFs);
      vi.spyOn(asyncFs, "lstat").mockImplementation((async (candidate, options) => {
        if (candidate === target) order.push("target");
        return actual(candidate, options);
      }) as typeof asyncFs.lstat);
    } else {
      const actual = fs.lstatSync.bind(fs);
      vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
        if (candidate === target) order.push("target");
        return actual(candidate, options);
      }) as typeof fs.lstatSync);
    }
    const resolve = mode === "async"
      ? resolveRootPathWithCanonicalRootObservation
      : resolveRootPathSyncWithCanonicalRootObservation;
    const result = await resolve({
      rootPath, absolutePath: target, boundaryLabel: "fixture",
    }, observedRoot => {
      expect(observedRoot).toBe(rootPath);
      order.push("root");
    });
    expect(result.kind).toBe("file");
    expect(result.exists).toBe(true);
    expect(order).toEqual(["root", "target"]);
  },
);

itPosix.each(["async", "sync"] as const)("%s reports an existing FIFO as other", async mode => {
  const rootPath = await tempRoot("fs-safe-root-metadata-fifo-");
  const absolutePath = path.join(rootPath, "fifo");
  expect(spawnSync("mkfifo", [absolutePath]).status).toBe(0);
  const resolve = mode === "async" ? resolveRootPath : resolveRootPathSync;
  const result = await resolve({ rootPath, absolutePath, boundaryLabel: "fixture" });
  expect(result).toMatchObject({ canonicalPath: absolutePath, exists: true, kind: "other" });
});

it.each(["async", "sync"] as const)("%s propagates final metadata failures", async mode => {
  const rootPath = await tempRoot("fs-safe-root-metadata-failure-");
  const absolutePath = path.join(rootPath, "value");
  fs.writeFileSync(absolutePath, "value");
  const failure = Object.assign(new Error("final metadata denied"), { code: "EACCES" });
  const stat = fs.statSync.bind(fs);
  const metadata = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
    if (candidate === absolutePath) throw failure;
    return stat(candidate, options);
  }) as typeof fs.statSync);
  const asyncStat = asyncFs.stat.bind(asyncFs);
  const asyncMetadata = vi.spyOn(asyncFs, "stat").mockImplementation((async (candidate, options) => {
    if (candidate === absolutePath) throw failure;
    return asyncStat(candidate, options);
  }) as typeof asyncFs.stat);
  const params = { rootPath, absolutePath, boundaryLabel: "fixture" };
  if (mode === "async") await expect(resolveRootPath(params)).rejects.toBe(failure);
  else expect(() => resolveRootPathSync(params)).toThrow(failure);
  expect(mode === "async" && process.platform !== "win32" ? asyncMetadata : metadata).toHaveBeenCalledWith(absolutePath);
});

it("returns rejected Promises for eager validation and canonical-root callback failures", async () => {
  const rootPath = await tempRoot("fs-safe-root-metadata-rejection-");
  const params = { rootPath, absolutePath: rootPath, boundaryLabel: "fixture" };
  let invalid: ReturnType<typeof resolveRootPath> | undefined;
  expect(() => { invalid = resolveRootPath({ ...params, absolutePath: "bad\0path" }); }).not.toThrow();
  await expect(invalid).rejects.toMatchObject({ code: "invalid-path" });
  const failure = new Error("callback\nfailure");
  let callback: ReturnType<typeof resolveRootPath> | undefined;
  expect(() => {
    callback = resolveRootPathWithCanonicalRootObservation(params, () => { throw failure; });
  }).not.toThrow();
  await expect(callback).rejects.toBe(failure);
  expect(failure.message).toBe("callback\\u000afailure");
});
