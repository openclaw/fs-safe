import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root, type RootEntriesOptions } from "../src/root.js";
import type { DirEntry } from "../src/types.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function collect(entries: AsyncIterable<DirEntry>): Promise<DirEntry[]> {
  const result: DirEntry[] = [];
  for await (const entry of entries) result.push(entry);
  return result;
}

function observeStreams() {
  const calls = { read: 0, close: 0 };
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async () => {
      calls.read += 1;
      return await read();
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      calls.close += 1;
      await close();
    });
    return handle;
  });
  return calls;
}

it.each(["filesystem", "sorted"] as const)("observes one directory without descending in %s order", async (order) => {
  const directory = await tempRoot("fs-safe-entries-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "child"), "unused");
  await fs.writeFile(path.join(directory, "value"), "contents");
  await fs.link(path.join(directory, "value"), path.join(directory, "hardlink"));
  const capability = await root(directory);
  const entries = await collect(capability.entries("", { order, maxEntries: 3 }));
  expect(entries.map(entry => entry.name).sort()).toEqual(["hardlink", "nested", "value"]);
  expect(entries.find(entry => entry.name === "nested")).toMatchObject({ isDirectory: true, isSymbolicLink: false });
  expect(entries.find(entry => entry.name === "value")).toMatchObject({ isFile: true, nlink: 2, size: 8 });
});

itPosix.each(["filesystem", "sorted"] as const)("reports contained, outside, and dangling links without following in %s order", async (order) => {
  const directory = await tempRoot("fs-safe-entries-links-");
  const outside = await tempRoot("fs-safe-entries-outside-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.symlink("nested", path.join(directory, "inside"), "dir");
  await fs.symlink(outside, path.join(directory, "outside"), "dir");
  await fs.symlink("missing", path.join(directory, "dangling"));
  const capability = await root(directory, { symlinks: "reject" });
  const entries = await collect(capability.entries("", { order, maxEntries: 4 }));
  expect(entries.filter(entry => entry.isSymbolicLink).map(entry => entry.name).sort())
    .toEqual(["dangling", "inside", "outside"]);
  for (const entry of entries.filter(entry => entry.isSymbolicLink)) {
    expect(entry.isDirectory).toBe(false);
    expect(entry.isFile).toBe(false);
    expect(entry.size).toBe((await fs.lstat(path.join(directory, entry.name))).size);
  }
});

it.each(["filesystem", "sorted"] as const)("enforces the directory path's symlink policy in %s order", async (order) => {
  const directory = await tempRoot("fs-safe-entries-policy-");
  const outside = await tempRoot("fs-safe-entries-policy-outside-");
  await fs.mkdir(path.join(directory, "nested", "child"), { recursive: true });
  await fs.writeFile(path.join(directory, "nested", "child", "value"), "content");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(path.join(directory, "nested"), path.join(directory, "alias"), linkType);
  await fs.symlink(outside, path.join(directory, "outside"), linkType);
  const capability = await root(directory);
  await expect(collect(capability.entries("alias", { order }))).rejects.toMatchObject({ code: "symlink" });
  expect((await collect(capability.entries("alias", { order, symlinks: "follow-within-root" }))).map(entry => entry.name))
    .toEqual(["child"]);
  const parents = await root(directory, { symlinks: "follow-parents-within-root" });
  expect((await collect(parents.entries("alias/child", { order }))).map(entry => entry.name)).toEqual(["value"]);
  await expect(collect(parents.entries("alias", { order }))).rejects.toMatchObject({ code: "symlink" });
  await expect(collect(capability.entries("outside", { order, symlinks: "follow-within-root" })))
    .rejects.toMatchObject({ code: "outside-workspace" });
});

it.each(["filesystem", "sorted"] as const)("bounds name reads and metadata in %s order, including zero and exact limits", async (order) => {
  const directory = await tempRoot("fs-safe-entries-budget-");
  await fs.writeFile(path.join(directory, "b"), "b");
  await fs.writeFile(path.join(directory, "a"), "a");
  const capability = await root(directory);
  for (const maxEntries of [0, 1, 2]) {
    const calls = observeStreams();
    const seen: string[] = [];
    const lstat = fsSync.lstatSync.bind(fsSync);
    const observed: string[] = [];
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (path.dirname(String(args[0])) === directory) observed.push(path.basename(String(args[0])));
      return lstat(...args);
    });
    const readdir = vi.spyOn(fs, "readdir");
    const consume = async () => {
      for await (const entry of capability.entries("", { order, maxEntries })) seen.push(entry.name);
    };
    if (maxEntries < 2) await expect(consume()).rejects.toMatchObject({ code: "too-large" });
    else await consume();
    expect(calls.read).toBe(maxEntries + 1);
    expect(calls.close).toBe(1);
    expect(readdir).not.toHaveBeenCalled();
    expect(observed).toHaveLength(order === "sorted" && maxEntries < 2 ? 0 : maxEntries);
    expect(seen).toEqual(observed);
    if (order === "sorted" && maxEntries === 2) expect(seen).toEqual(["a", "b"]);
    vi.restoreAllMocks();
  }
});

it.each(["break", "abort"] as const)("closes the incremental stream after %s without observing the unused suffix", async (outcome) => {
  const directory = await tempRoot("fs-safe-entries-close-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const capability = await root(directory);
  const calls = observeStreams();
  const controller = new AbortController();
  const consume = async () => {
    for await (const _entry of capability.entries("", { signal: controller.signal })) {
      if (outcome === "break") break;
      controller.abort();
    }
  };
  if (outcome === "break") await consume();
  else await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual({ read: 1, close: 1 });
});

it.each(["filesystem", "sorted"] as const)("rejects replaced root and nested directories across %s yields", async (order) => {
  const parent = await tempRoot("fs-safe-entries-swap-");
  for (const relative of ["", "nested"]) {
    const directory = path.join(parent, relative === "" ? "root" : "other-root");
    const target = path.join(directory, relative);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "a"), "original");
    await fs.writeFile(path.join(target, "b"), "original");
    const capability = await root(directory);
    const iterator = capability.entries(relative, { order, maxEntries: 2 });
    expect((await iterator.next()).value).toMatchObject({ isFile: true, size: 8 });
    await fs.rename(target, `${target}-moved`);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "a"), "replacement");
    await fs.writeFile(path.join(target, "b"), "replacement");
    await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
  }
});

it("observes sorted entry metadata when consumed instead of replaying a stale snapshot", async () => {
  const directory = await tempRoot("fs-safe-entries-fresh-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const iterator = (await root(directory)).entries("", { order: "sorted" });
  expect((await iterator.next()).value).toMatchObject({ name: "a", size: 1 });
  await fs.writeFile(path.join(directory, "b"), "updated");
  expect((await iterator.next()).value).toMatchObject({ name: "b", size: 7 });
  expect((await iterator.next()).done).toBe(true);
});

it("rejects invalid options and pre-aborted iteration before directory enumeration", async () => {
  const capability = await root(await tempRoot("fs-safe-entries-invalid-"));
  const opendir = vi.spyOn(fs, "opendir");
  for (const maxEntries of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(collect(capability.entries("", { maxEntries }))).rejects.toBeInstanceOf(RangeError);
  }
  await expect(collect(capability.entries("", { order: "unknown" as RootEntriesOptions["order"] })))
    .rejects.toBeInstanceOf(TypeError);
  const refusal = new Error("cancelled");
  await expect(collect(capability.entries("", { signal: AbortSignal.abort(refusal) }))).rejects.toBe(refusal);
  await expect(collect(capability.entries("../"))).rejects.toMatchObject({ code: "invalid-path" });
  expect(opendir).not.toHaveBeenCalled();
});

it("settles cancellation during bounded sorted-name collection and closes the stream", async () => {
  const directory = await tempRoot("fs-safe-entries-sort-abort-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const capability = await root(directory);
  const controller = new AbortController();
  const refusal = new Error("cancelled during directory read");
  const opendir = fs.opendir.bind(fs);
  let closed = false;
  let settled = false;
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async () => {
      const entry = await read();
      controller.abort(refusal);
      settled = true;
      return entry;
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await close();
      closed = true;
    });
    return handle;
  });
  await expect(collect(capability.entries("", { order: "sorted", maxEntries: 2, signal: controller.signal })))
    .rejects.toBe(refusal);
  expect(settled).toBe(true);
  expect(closed).toBe(true);
});

it("retains an iteration failure when directory disposal also fails", async () => {
  const directory = await tempRoot("fs-safe-entries-suppressed-");
  await fs.writeFile(path.join(directory, "entry"), "value");
  const capability = await root(directory);
  const controller = new AbortController();
  const refusal = new Error("cancelled");
  const closeFailure = new Error("close failed");
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await close();
      throw closeFailure;
    });
    return handle;
  });
  const iterator = capability.entries("", { signal: controller.signal });
  await iterator.next();
  controller.abort(refusal);
  await expect(iterator.next()).rejects.toMatchObject({
    name: "SuppressedError", error: closeFailure, suppressed: refusal,
  });
});
