import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import type { RootWalkEntry, RootWalkOptions } from "../src/root-walk.js";
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
