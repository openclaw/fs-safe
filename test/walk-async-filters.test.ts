import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  walkDirectory,
  walkDirectorySync,
  type AsyncWalkDirectoryOptions,
  type WalkDirectoryEntry,
  type WalkDirectoryOptions,
} from "../src/walk.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("awaits file selection and marker-based pruning before visiting children", async () => {
  const directory = await tempRoot("fs-safe-walk-async-filters-");
  await fs.mkdir(path.join(directory, "keep"));
  await fs.mkdir(path.join(directory, "container"));
  await fs.writeFile(path.join(directory, "keep", "public.txt"), "public");
  await fs.writeFile(path.join(directory, "container", "SKILL.md"), "private");
  await fs.writeFile(path.join(directory, "container", "hidden.txt"), "private");
  await fs.writeFile(path.join(directory, "public.txt"), "public");
  const operations: string[] = [];

  const options: AsyncWalkDirectoryOptions = {
    async include(entry) {
      expect(this).toBe(options);
      operations.push(`include:${entry.relativePath}`);
      const include = entry.kind === "file" && await fs.readFile(entry.path, "utf8") === "public";
      operations.push(`included:${entry.relativePath}`);
      return include;
    },
    async descend(entry) {
      expect(this).toBe(options);
      operations.push(`descend:${entry.relativePath}`);
      const marked = await fs.access(path.join(entry.path, "SKILL.md")).then(() => true, () => false);
      operations.push(`descended:${entry.relativePath}`);
      return !marked;
    },
  };
  const result = await walkDirectory(directory, options);

  expect(result.entries.map((entry) => entry.relativePath).sort()).toEqual([
    path.join("keep", "public.txt"), "public.txt",
  ]);
  expect(result.scannedEntryCount).toBe(4);
  expect(result.failedDirs).toEqual([]);
  expect(result.truncated).toBe(false);
  for (let index = 0; index < operations.length; index += 2) {
    const operation = operations[index]!;
    expect(operations[index + 1]).toBe(operation.replace(/^include:/, "included:").replace(/^descend:/, "descended:"));
  }
});

it("charges rejected async selections to the same examined-entry budget", async () => {
  const directory = await tempRoot("fs-safe-walk-async-budget-");
  await Promise.all(["a", "b", "c"].map((name) => fs.writeFile(path.join(directory, name), name)));
  const selected: string[] = [];
  const result = await walkDirectory(directory, {
    maxEntries: 2,
    include: async (entry) => {
      await fs.stat(entry.path);
      selected.push(entry.relativePath);
      return false;
    },
  });
  expect(result.entries).toEqual([]);
  expect(selected).toHaveLength(2);
  expect(result.scannedEntryCount).toBe(2);
  expect(result.truncated).toBe(true);
});

it("keeps synchronous option bags valid for both walkers", async () => {
  const directory = await tempRoot("fs-safe-walk-shared-options-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
  const options: WalkDirectoryOptions = {
    symlinks: "include",
    maxDepth: 2,
    include: (entry) => entry.kind === "file",
    descend: (entry) => entry.name === "nested",
  };
  const asynchronous = await walkDirectory(directory, options);
  const synchronous = walkDirectorySync(directory, options);
  expect(asynchronous).toEqual(synchronous);
  expect(asynchronous.entries.map((entry) => entry.relativePath)).toEqual([path.join("nested", "value.txt")]);
});

it("does not add microtask handoffs between synchronous file selections", async () => {
  const directory = await tempRoot("fs-safe-walk-sync-filter-order-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "b");
  let handedOff = false;
  const observations: boolean[] = [];
  const options: WalkDirectoryOptions = {
    include() {
      expect(this).toBe(options);
      observations.push(handedOff);
      queueMicrotask(() => { handedOff = true; });
      return false;
    },
  };
  const result = await walkDirectory(directory, options);
  expect(observations).toEqual([false, false]);
  expect(result.entries).toEqual([]);
  expect(result.scannedEntryCount).toBe(2);
});

it.each(["include", "descend"] as const)("propagates rejected %s decisions", async (callback) => {
  const directory = await tempRoot("fs-safe-walk-filter-rejection-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "hidden.txt"), "hidden");
  const failure = new Error("marker inspection failed");
  await expect(walkDirectory(directory, {
    [callback]: async () => {
      await fs.stat(directory);
      throw failure;
    },
  })).rejects.toBe(failure);
});

it.each(["include", "descend"] as const)("preserves resolved %s truthiness and nullish defaults", async (callback) => {
  const directory = await tempRoot("fs-safe-walk-compatible-filter-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
  for (const { value, selected } of [
    { value: "false", selected: true },
    { value: undefined, selected: true },
    { value: null, selected: true },
    { value: 1, selected: true },
    { value: {}, selected: true },
    { value: "", selected: false },
    { value: 0, selected: false },
    { value: false, selected: false },
  ]) {
    for (const asynchronous of [false, true]) {
      const result = await walkDirectory(directory, {
        [callback]: () => (asynchronous ? Promise.resolve(value) : value) as never,
      });
      expect(result.entries.map((entry) => entry.relativePath)).toEqual(
        selected ? ["nested", path.join("nested", "value.txt")]
          : callback === "include" ? [] : ["nested"],
      );
    }
  }
});

it.each(["include", "descend"] as const)("uses native await semantics for %s promise decisions", async (callback) => {
  const directory = await tempRoot("fs-safe-walk-native-await-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
  const decision = Promise.resolve(false);
  Object.defineProperty(decision, "then", {
    get() { throw new Error("native await must not read an overridden then property"); },
  });
  const result = await walkDirectory(directory, { [callback]: () => decision });
  expect(result.entries.map((entry) => entry.relativePath)).toEqual(callback === "include" ? [] : ["nested"]);
});

it.each(["include", "descend"] as const)("reads a %s thenable accessor once with its original receiver", async (callback) => {
  const directory = await tempRoot("fs-safe-walk-thenable-await-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
  let reads = 0;
  let invocations = 0;
  const result = await walkDirectory(directory, {
    [callback]: () => {
      invocations += 1;
      const decision = {
        get then() {
          reads += 1;
          return function (this: unknown, resolve: (value: boolean) => void) {
            expect(this).toBe(decision);
            resolve(false);
          };
        },
      };
      return decision as never;
    },
  });
  expect(reads).toBe(invocations);
  expect(result.entries.map((entry) => entry.relativePath)).toEqual(callback === "include" ? [] : ["nested"]);
});

it.each(["include", "descend"] as const)("rejects falsy non-callable %s callbacks", async (callback) => {
  const directory = await tempRoot("fs-safe-walk-non-callable-filter-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
  for (const value of [false, 0, ""]) {
    await expect(walkDirectory(directory, { [callback]: value } as never)).rejects.toThrow(TypeError);
  }
  for (const value of [undefined, null]) {
    const result = await walkDirectory(directory, { [callback]: value } as never);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "nested", path.join("nested", "value.txt"),
    ]);
  }
});

it.each(["include", "descend"] as const)("ignores an overridden %s callback call property", async (callback) => {
  const directory = await tempRoot("fs-safe-walk-overridden-call-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
  const invoked: string[] = [];
  const filter = function (this: AsyncWalkDirectoryOptions, entry: WalkDirectoryEntry): boolean {
    expect(this).toBe(options);
    invoked.push(entry.relativePath);
    return true;
  };
  Object.defineProperty(filter, "call", {
    get() { throw new Error("callback call property must not be read"); },
  });
  const options: AsyncWalkDirectoryOptions = { [callback]: filter };
  const result = await walkDirectory(directory, options);
  const expected = ["nested", path.join("nested", "value.txt")];
  expect(result.entries.map((entry) => entry.relativePath)).toEqual(expected);
  expect(invoked).toEqual(callback === "include" ? expected : ["nested"]);
});
