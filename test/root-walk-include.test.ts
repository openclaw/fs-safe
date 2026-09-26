import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import type { RootWalkEntry, RootWalkOptions } from "../src/root-walk.js";
import { realpathSync } from "../src/realpath.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const orders = [
  { name: "sorted snapshot", options: { order: "sorted" } },
  { name: "sorted batches", options: { order: "sorted", maxEntries: 16 } },
  { name: "filesystem", options: { order: "filesystem" } },
] as const;

it.each(orders)("includes link metadata without following targets in $name order", async ({ options }) => {
  const container = await tempRoot("fs-safe-walk-include-");
  const directory = path.join(container, "root");
  await fs.mkdir(path.join(directory, "nested"), { recursive: true });
  await fs.writeFile(path.join(directory, "nested/value"), "value");
  for (const [name, target] of [["alias", "nested"], ["dangling", "absent"], ["outside", ".."]] as const) {
    await fs.symlink(process.platform === "win32" ? path.resolve(directory, target) : target,
      path.join(directory, name), process.platform === "win32" ? "junction" : undefined);
  }
  const capability = await root(directory);
  const seen: string[] = [];
  const policy: RootWalkOptions<"include"> = {
    ...options,
    symlinkPolicy: "include",
    async entryFilter(entry) {
      expect(this).toBe(policy);
      if (entry.kind === "symlink") seen.push(entry.relativePath);
      return "include";
    },
  };
  const entries = await Array.fromAsync(capability.walk("", policy));
  expect(entries.map(({ relativePath }) => relativePath).sort()).toEqual([
    "alias", "dangling", "nested", "nested/value", "outside",
  ]);
  expect(seen.sort()).toEqual(["alias", "dangling", "outside"]);
  for (const entry of entries.filter(({ kind }) => kind === "symlink")) {
    expect(entry.size).toBe((await fs.lstat(path.join(directory, entry.relativePath))).size);
  }
});

it.each(orders)("preserves a starting alias and literal descendants in $name order", async ({ options }) => {
  const directory = await tempRoot("fs-safe-walk-include-alias-");
  const target = path.join(directory, "target");
  await fs.mkdir(path.join(target, "~", "nested"), { recursive: true });
  await fs.writeFile(path.join(target, "~", "nested", "value"), "literal");
  await fs.symlink(target, path.join(directory, "alias"),
    process.platform === "win32" ? "junction" : "dir");
  const capability = await root(directory);

  const entries = await Array.fromAsync(capability.walk("alias", { ...options, symlinkPolicy: "include" }));

  expect(entries.map(entry => entry.relativePath)).toEqual([
    "alias/~", "alias/~/nested", "alias/~/nested/value",
  ]);
  expect(entries.at(-1)).toEqual({ relativePath: "alias/~/nested/value", kind: "file", size: 7 });
});

itPosix("counts filtered links against the entry budget without following or expanding them", async () => {
  const directory = await tempRoot("fs-safe-walk-include-budget-");
  await fs.symlink("absent", path.join(directory, "a-link"));
  await fs.writeFile(path.join(directory, "b-file"), "value");
  const capability = await root(directory);
  const seen: string[] = [];
  const entries = await Array.fromAsync(capability.walk("", {
    symlinkPolicy: "include", maxEntries: 1, maxDepth: 0,
    entryFilter(entry) {
      seen.push(entry.kind);
      return "skip-subtree";
    },
  }));
  expect(seen).toEqual(["symlink"]);
  expect(entries).toEqual([{ relativePath: "b-file", kind: "truncated", size: 0 }]);
});

it.each(["filter", "yield"] as const)("reports a child changed to a link during %s without following it", async phase => {
  const container = await tempRoot("fs-safe-walk-include-swap-");
  const directory = path.join(container, "root");
  await fs.mkdir(path.join(directory, "a"), { recursive: true });
  await fs.mkdir(path.join(directory, "b"));
  await fs.writeFile(path.join(directory, "b/value"), "target");
  const capability = await root(directory);
  const swap = async () => {
    await fs.rename(path.join(directory, "a"), path.join(container, "moved"));
    await fs.symlink(path.join(directory, "b"), path.join(directory, "a"),
      process.platform === "win32" ? "junction" : "dir");
  };
  const entries: RootWalkEntry<"include">[] = [];
  for await (const entry of capability.walk("", {
    symlinkPolicy: "include", onDirectoryError: "skip-and-report",
    entryFilter: phase === "filter" ? async entry => {
      if (entry.relativePath === "a") await swap();
      return "include";
    } : undefined,
  })) {
    entries.push(entry);
    if (phase === "yield" && entry.relativePath === "a" && entry.kind === "directory") await swap();
  }
  expect(entries).toContainEqual({ relativePath: "a", kind: "directory-error", size: 0,
    error: expect.objectContaining({ code: "path-mismatch" }) });
  expect(entries.map(entry => entry.relativePath)).not.toContain("a/value");
  expect(entries.map(entry => entry.relativePath)).toContain("b/value");
});

it("fails closed on a substituted directory and closes its streamed iterator", async () => {
  const container = await tempRoot("fs-safe-walk-include-close-");
  const directory = path.join(container, "root");
  await fs.mkdir(path.join(directory, "child"), { recursive: true });
  const capability = await root(directory);
  const opendir = fs.opendir.bind(fs);
  const close = vi.fn();
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const original = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { close(); await original(); });
    return handle;
  });
  const iterator = capability.walk("", { symlinkPolicy: "include", order: "filesystem" });
  expect((await iterator.next()).value).toMatchObject({ kind: "directory", relativePath: "child" });
  await fs.rename(path.join(directory, "child"), path.join(container, "moved"));
  await fs.symlink(path.join(container, "moved"), path.join(directory, "child"),
    process.platform === "win32" ? "junction" : "dir");
  await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
  expect(close).toHaveBeenCalledOnce();
});

it.each(orders.flatMap(mode => ["different", "original"].flatMap(target =>
  [false, true].map(report => ({ ...mode, target, report })),
)))("binds child admission to listing in $name order ($target target, report=$report)", async ({ options, target, report }) => {
  const directory = await tempRoot("fs-safe-walk-admission-");
  const child = path.join(directory, "child");
  const moved = path.join(directory, "moved");
  const other = path.join(directory, "target");
  await fs.mkdir(child);
  await fs.mkdir(other);
  await fs.writeFile(path.join(child, "payload.txt"), "admitted");
  await fs.writeFile(path.join(other, "payload.txt"), "foreign");
  const capability = await root(directory);
  const iterator = capability.walk("", {
    ...options, symlinkPolicy: "include",
    onDirectoryError: report ? "skip-and-report" : "throw",
  });
  let next;
  do { next = await iterator.next(); }
  while (!next.done && next.value.relativePath !== "child");
  expect(next.value).toMatchObject({ relativePath: "child", kind: "directory" });

  const lstat = fsSync.lstatSync.bind(fsSync);
  let queued = false;
  let swapped = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (!queued && String(args[0]) === child && stat?.isDirectory()) {
      queued = true;
      // Resolution is synchronous; run after its observations, before the awaiting walker lists.
      queueMicrotask(() => {
        fsSync.renameSync(child, moved);
        fsSync.symlinkSync(target === "original" ? moved : other, child,
          process.platform === "win32" ? "junction" : "dir");
        swapped = true;
      });
    }
    return stat;
  });
  const entries: RootWalkEntry<"include">[] = [];
  let failure: unknown;
  try {
    for await (const entry of iterator) entries.push(entry);
  } catch (error) {
    failure = error;
  }
  expect(swapped).toBe(true);
  expect(entries.map(entry => entry.relativePath)).not.toContain("child/payload.txt");
  if (report) {
    expect(failure).toBeUndefined();
    expect(entries).toContainEqual({ relativePath: "child", kind: "directory-error", size: 0,
      error: expect.objectContaining({ code: "path-mismatch" }) });
  } else {
    expect(failure).toMatchObject({ code: "path-mismatch" });
  }
});

it.each(orders)("rejects ancestor substitution during child admission in $name order", async ({ options }) => {
  const directory = await tempRoot("fs-safe-walk-ancestor-admission-");
  const ancestor = path.join(directory, "ancestor");
  const moved = path.join(directory, "moved");
  await fs.mkdir(path.join(ancestor, "child"), { recursive: true });
  await fs.writeFile(path.join(ancestor, "child", "payload.txt"), "admitted");
  const capability = await root(directory);
  const iterator = capability.walk("", {
    ...options, symlinkPolicy: "include", onDirectoryError: "skip-and-report",
  });
  expect((await iterator.next()).value).toMatchObject({ relativePath: "ancestor", kind: "directory" });
  expect((await iterator.next()).value).toMatchObject({ relativePath: "ancestor/child", kind: "directory" });

  const lstat = fsSync.lstatSync.bind(fsSync);
  let swapped = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (!swapped && String(args[0]) === ancestor && stat?.isDirectory()) {
      fsSync.renameSync(ancestor, moved);
      fsSync.symlinkSync(moved, ancestor, process.platform === "win32" ? "junction" : "dir");
      swapped = true;
    }
    return stat;
  });

  const entries = await Array.fromAsync(iterator);

  expect(swapped).toBe(true);
  expect(entries.map(entry => entry.relativePath)).not.toContain("ancestor/child/payload.txt");
  expect(entries).toContainEqual({ relativePath: "ancestor/child", kind: "directory-error", size: 0,
    error: expect.objectContaining({ code: "path-mismatch" }) });
});

it("preserves filesystem errors while admitting a child directory", async () => {
  const directory = await tempRoot("fs-safe-walk-admission-error-");
  const child = path.join(directory, "child");
  await fs.mkdir(child);
  const capability = await root(directory);
  const iterator = capability.walk("", { symlinkPolicy: "include" });
  expect((await iterator.next()).value).toMatchObject({ relativePath: "child", kind: "directory" });
  const realpath = realpathSync.native;
  const denied = Object.assign(new Error("directory observation denied"), { code: "EACCES" });
  vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
    if (candidate === child) throw denied;
    return realpath(candidate);
  });

  await expect(iterator.next()).rejects.toBe(denied);
});
