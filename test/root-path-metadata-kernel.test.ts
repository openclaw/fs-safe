import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as canonical from "../src/realpath.js";
import {
  resolveRootPath,
  resolveRootPathSync,
  resolveRootPathSyncWithCanonicalRootObservation,
  resolveRootPathWithCanonicalRootObservation,
} from "../src/root-path.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

itPosix("preserves native and ordinary expansion of raw parent segments inside symlink targets", async () => {
  const rootPath = await tempRoot("fs-safe-root-metadata-parent-");
  const target = path.join(rootPath, "target");
  fs.mkdirSync(path.join(target, "child"), { recursive: true });
  fs.symlinkSync("target/child", path.join(rootPath, "link"), "dir");
  const absolutePath = path.join(rootPath, "indirect");
  fs.symlinkSync("link/..", absolutePath, "dir");
  const params = { rootPath, absolutePath, boundaryLabel: "fixture" };
  await expect(resolveRootPath(params)).resolves.toMatchObject({ canonicalPath: target, exists: true, kind: "directory" });
  expect(resolveRootPathSync(params)).toMatchObject({ canonicalPath: rootPath, exists: true, kind: "directory" });
});

it.each(["async", "sync"] as const)(
  "%s retains its canonicalizer for roots, symlinks, and missing symlink targets",
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
    const actual = mode === "async" ? canonical.realpathSync.native : canonical.realpathSync;
    const canonicalize = mode === "async"
      ? vi.spyOn(canonical.realpathSync, "native")
      : vi.spyOn(canonical, "realpathSync");
    const calls: string[] = [];
    canonicalize.mockImplementation(candidate => {
      calls.push(candidate);
      return actual(candidate);
    });
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
  const actual = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
    if (candidate === rootPath && options?.throwIfNoEntry === false) throw failure;
    return actual(candidate, options);
  }) as typeof fs.lstatSync);
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
    const actual = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      if (candidate === target) order.push("target");
      return actual(candidate, options);
    }) as typeof fs.lstatSync);
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
  const params = { rootPath, absolutePath, boundaryLabel: "fixture" };
  if (mode === "async") await expect(resolveRootPath(params)).rejects.toBe(failure);
  else expect(() => resolveRootPathSync(params)).toThrow(failure);
  expect(metadata).toHaveBeenCalledWith(absolutePath);
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
