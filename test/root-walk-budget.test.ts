import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function observeChildMetadata(directory: string): string[] {
  const names: string[] = [];
  const observe = (candidate: fsSync.PathLike) => {
    if (path.dirname(String(candidate)) === directory) names.push(path.basename(String(candidate)));
  };
  const sync = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    observe(args[0]);
    return sync(...args);
  });
  const lstatAsync = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    observe(args[0]);
    return await lstatAsync(...args);
  });
  return names;
}

function observeDirectoryStream(): { reads: number; closed: number } {
  const calls = { reads: 0, closed: 0 };
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async () => {
      calls.reads += 1;
      return await read();
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      calls.closed += 1;
      await close();
    });
    return handle;
  });
  return calls;
}

it.each([0, 2, 5])("bounds metadata to %i examined entries without changing sorted truncation", async (maxEntries) => {
  const directory = await tempRoot("fs-safe-walk-budget-");
  const names = ["e", "d", "c", "b", "a"];
  await Promise.all(names.map(name => fs.writeFile(path.join(directory, name), name)));
  const capability = await root(directory);
  const observed = observeChildMetadata(directory);
  const entries = [];
  for await (const entry of capability.walk("", { symlinkPolicy: "skip", maxEntries })) entries.push(entry);
  const sorted = names.toSorted();
  expect(entries).toEqual([
    ...sorted.slice(0, maxEntries).map(relativePath => ({ relativePath, kind: "file", size: 1 })),
    ...(maxEntries < names.length ? [{ relativePath: sorted[maxEntries], kind: "truncated", size: 0 }] : []),
  ]);
  expect(observed).toEqual(sorted.slice(0, maxEntries));
});

it.each([0, 2, 5])("reads only %i entries and one lookahead in filesystem order", async (maxEntries) => {
  const directory = await tempRoot("fs-safe-walk-stream-budget-");
  const names = ["a", "b", "c", "d", "e"];
  await Promise.all(names.map(name => fs.writeFile(path.join(directory, name), name)));
  const capability = await root(directory);
  const observed = observeChildMetadata(directory);
  const readdir = vi.spyOn(fs, "readdir");
  const calls = observeDirectoryStream();
  const entries = [];
  for await (const entry of capability.walk("", { symlinkPolicy: "skip", order: "filesystem", maxEntries })) entries.push(entry);
  expect(readdir).not.toHaveBeenCalled();
  expect(calls.reads).toBe(maxEntries + 1);
  expect(calls.closed).toBe(1);
  expect(observed).toHaveLength(maxEntries);
  expect(entries.filter(entry => entry.kind === "file").map(entry => entry.relativePath)).toEqual(observed);
  expect(entries.filter(entry => entry.kind === "truncated")).toHaveLength(maxEntries < names.length ? 1 : 0);
});

it.each(["break", "abort", "limit-error", "filter-error"] as const)("closes directory streams on %s", async (outcome) => {
  const directory = await tempRoot("fs-safe-walk-stream-close-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const capability = await root(directory);
  const calls = observeDirectoryStream();
  const controller = new AbortController();
  const observed: string[] = [];
  const consume = async () => {
    for await (const entry of capability.walk("", {
      symlinkPolicy: "skip", order: "filesystem", signal: controller.signal,
      maxEntries: outcome === "limit-error" ? 1 : undefined,
      limitBehavior: "throw",
      entryFilter: () => {
        if (outcome === "filter-error") throw new Error("filter failed");
        return "include";
      },
    })) {
      observed.push(entry.relativePath);
      if (outcome === "break") break;
      if (outcome === "abort") controller.abort();
    }
  };
  if (outcome === "break") await consume();
  else await expect(consume()).rejects.toMatchObject(
    outcome === "abort" ? { name: "AbortError" }
      : outcome === "limit-error" ? { code: "too-large" }
        : { message: "filter failed" },
  );
  expect(calls.closed).toBe(1);
  expect(observed).toHaveLength(outcome === "filter-error" ? 0 : 1);
  expect(calls.reads).toBe(outcome === "limit-error" ? 2 : 1);
});

it.each(["sorted", "filesystem"] as const)("rejects a directory replaced across %s iterator yields", async (order) => {
  const directory = await tempRoot("fs-safe-walk-directory-swap-");
  const nested = path.join(directory, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "a"), "original");
  await fs.writeFile(path.join(nested, "b"), "original");
  const capability = await root(directory);
  const iterator = capability.walk("nested", { order, symlinkPolicy: "skip" });
  expect((await iterator.next()).value).toMatchObject({ kind: "file", size: 8 });
  await fs.rename(nested, path.join(directory, "moved"));
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "a"), "replacement");
  await fs.writeFile(path.join(nested, "b"), "replacement");
  await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
});

it.each(["sorted", "filesystem"] as const)("preserves filesystem-supported case aliases in %s order", async (order, context) => {
  const directory = await tempRoot("fs-safe-walk-case-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value"), "value");
  try {
    await fs.stat(path.join(directory, "NESTED"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    context.skip("fixture filesystem is case-sensitive");
    return;
  }
  const capability = await root(directory);
  const entries = [];
  for await (const entry of capability.walk("NESTED", { order, symlinkPolicy: "skip" })) entries.push(entry);
  expect(entries).toEqual([{ relativePath: "NESTED/value", kind: "file", size: 5 }]);
});

it("does not inspect a directory's unused suffix after the caller stops iteration", async () => {
  const directory = await tempRoot("fs-safe-walk-break-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "z"), "z");
  const capability = await root(directory);
  const observed = observeChildMetadata(directory);
  for await (const entry of capability.walk("", { symlinkPolicy: "skip" })) {
    expect(entry).toEqual({ relativePath: "a", kind: "file", size: 1 });
    break;
  }
  expect(observed).toEqual(["a"]);
});

it("does not inspect a parent suffix after a child consumes the remaining budget", async () => {
  const directory = await tempRoot("fs-safe-walk-nested-budget-");
  await fs.mkdir(path.join(directory, "a"));
  await fs.writeFile(path.join(directory, "a", "child"), "value");
  await fs.writeFile(path.join(directory, "z"), "unused");
  const capability = await root(directory);
  const observed = observeChildMetadata(directory);
  const entries = [];
  for await (const entry of capability.walk("", { symlinkPolicy: "skip", maxEntries: 2 })) entries.push(entry);
  expect(entries.map(({ relativePath, kind }) => ({ relativePath, kind }))).toEqual([
    { relativePath: "a", kind: "directory" },
    { relativePath: "a/child", kind: "file" },
    { relativePath: "z", kind: "truncated" },
  ]);
  expect(observed).not.toContain("z");
});
