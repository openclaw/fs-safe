import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import type { RootWalkOptions } from "../src/root-walk.js";
import { walkDirectory, walkDirectorySync, type WalkDirectoryOptions } from "../src/walk.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each([Infinity, -Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null, { valueOf: () => 1 }])(
  "rejects non-finite, unsafe, or coercible entry budget %j through each public traversal API",
  async (value) => {
    const directory = await tempRoot("fs-safe-budget-invalid-");
    const scoped = await root(directory);
    const maxEntries = value as number;
    const expected = new RangeError("maxEntries must be a non-negative safe integer");
    expect(() => walkDirectorySync(directory, { maxEntries })).toThrow(expected);
    await expect(walkDirectory(directory, { maxEntries })).rejects.toThrow(expected);
    await expect(scoped.walk("", { symlinkPolicy: "skip", maxEntries }).next()).rejects.toThrow(expected);
    await expect(scoped.entries("", { maxEntries }).next()).rejects.toThrow(expected);
  },
);

it.each(["sync", "async"] as const)("keeps %s walk validation ahead of later getters and path lookup", async (mode) => {
  const directory = path.join(await tempRoot("fs-safe-budget-order-"), "missing");
  const reads: string[] = [];
  const options: WalkDirectoryOptions = {
    get maxDepth() { reads.push("depth"); return Infinity; },
    get maxEntries(): number { reads.push("entries"); throw new Error("later getter"); },
    get symlinks(): "skip" { reads.push("symlinks"); throw new Error("later policy"); },
  };
  const expected = new RangeError("maxDepth must be a non-negative safe integer");
  if (mode === "sync") {
    expect(() => walkDirectorySync(directory, options)).toThrow(expected);
  } else {
    let pending: ReturnType<typeof walkDirectory> | undefined;
    expect(() => { pending = walkDirectory(directory, options); }).not.toThrow();
    await expect(pending).rejects.toThrow(expected);
  }
  expect(reads).toEqual(["depth"]);
});

it.each(["sync", "async"] as const)("keeps %s standalone entry budgets live after admission", async (mode) => {
  const directory = await tempRoot("fs-safe-budget-live-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const options: WalkDirectoryOptions = {
    maxEntries: undefined,
    include() {
      expect(this).toBe(options);
      this.maxEntries = 1;
      return true;
    },
  };
  const result = mode === "sync"
    ? walkDirectorySync(directory, options)
    : await walkDirectory(directory, options);
  expect(result.entries).toHaveLength(1);
  expect(result.scannedEntryCount).toBe(1);
  expect(result.truncated).toBe(true);
});

it("reads Root walk budgets once on iteration before observing cancellation", async () => {
  const scoped = await root(await tempRoot("fs-safe-root-budget-order-"));
  const reads: string[] = [];
  const options: RootWalkOptions = {
    symlinkPolicy: "skip",
    get maxDepth() { reads.push("depth"); return undefined; },
    get maxEntries() { reads.push("entries"); return Infinity; },
    get signal(): AbortSignal { reads.push("signal"); throw new Error("later cancellation getter"); },
  };
  const iterator = scoped.walk("", options);
  expect(reads).toEqual([]);
  await expect(iterator.next()).rejects.toThrow(new RangeError("maxEntries must be a non-negative safe integer"));
  expect(reads).toEqual(["depth", "entries"]);
});

it("rejects Root walk policy before observing a budget getter", async () => {
  const scoped = await root(await tempRoot("fs-safe-root-budget-policy-"));
  const budget = vi.fn(() => { throw new Error("budget getter"); });
  const iterator = scoped.walk("", { symlinkPolicy: "invalid" as "skip", get maxDepth() { return budget(); } });
  await expect(iterator.next()).rejects.toThrow(TypeError);
  expect(budget).not.toHaveBeenCalled();
});

it("retains the Root walk budget snapshot across filter callbacks", async () => {
  const directory = await tempRoot("fs-safe-root-budget-snapshot-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const scoped = await root(directory);
  const options: RootWalkOptions = {
    symlinkPolicy: "skip", maxEntries: undefined,
    entryFilter() { options.maxEntries = 0; return "include"; },
  };
  const entries = await Array.fromAsync(scoped.walk("", options));
  expect(entries.map(entry => entry.relativePath)).toEqual(["a", "b"]);
  expect(entries.every(entry => entry.kind === "file")).toBe(true);
});

it("keeps Root entries validation deferred and ahead of policy and cancellation failures", async () => {
  const scoped = await root(await tempRoot("fs-safe-entries-budget-order-"));
  const refusal = new Error("later cancellation");
  const iterator = scoped.entries("", {
    maxEntries: Infinity, order: "invalid" as "sorted", signal: AbortSignal.abort(refusal),
  });
  await expect(iterator.next()).rejects.toThrow(new RangeError("maxEntries must be a non-negative safe integer"));
});

it("preserves the captured undefined entries budget and unbounded sorted-name path", async () => {
  const directory = await tempRoot("fs-safe-entries-budget-snapshot-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  const scoped = await root(directory);
  let limit: number | undefined;
  const budget = vi.fn(() => limit);
  const opendir = vi.spyOn(fs, "opendir");
  const iterator = scoped.entries("", { order: "sorted", get maxEntries() { return budget(); } });
  expect(budget).toHaveBeenCalledTimes(1);
  limit = 0;
  const entries = await Array.fromAsync(iterator);
  expect(entries.map(entry => entry.name)).toEqual(["a", "b"]);
  expect(budget).toHaveBeenCalledTimes(1);
  expect(opendir).not.toHaveBeenCalled();
});
