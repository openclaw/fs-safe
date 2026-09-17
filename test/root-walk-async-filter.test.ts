import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import type { RootWalkEntry, RootWalkOptions } from "../src/root-walk.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const orders = [
  { name: "sorted snapshot", options: { order: "sorted" } },
  { name: "sorted batches", options: { order: "sorted", maxEntries: 16 } },
  { name: "filesystem", options: { order: "filesystem" } },
] as const;

it.each(orders)("awaits marker pruning in $name order", async ({ options: mode }) => {
  const directory = await tempRoot("fs-safe-root-async-prune-");
  for (const name of ["keep", "prune", "skip"]) {
    await fs.mkdir(path.join(directory, name));
    await fs.writeFile(path.join(directory, name, "value"), name);
  }
  await fs.writeFile(path.join(directory, "prune", "MARKER"), "marker");
  const capability = await root(directory);
  const options: RootWalkOptions = {
    ...mode, symlinkPolicy: "skip",
    async entryFilter(entry) {
      expect(this).toBe(options);
      if (entry.kind === "directory") {
        const marked = await fs.access(path.join(directory, entry.relativePath, "MARKER"))
          .then(() => true, () => false);
        if (marked) return "skip-subtree";
      }
      return entry.relativePath === "skip" ? "skip" : "include";
    },
  };
  const entries: RootWalkEntry[] = [];
  for await (const entry of capability.walk("", options)) entries.push(entry);
  expect(entries.map((entry) => entry.relativePath).sort()).toEqual([
    "keep", "keep/value", "skip/value",
  ]);
});

it.each(orders.flatMap((mode) => ["root", "directory"].map((replaced) => ({ ...mode, replaced }))))(
  "rejects $replaced replacement during a $name filter before yielding stale entries",
  async ({ options, replaced }) => {
    const container = await tempRoot("fs-safe-root-async-filter-swap-");
    const directory = path.join(container, "root");
    const nested = path.join(directory, "nested");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "value"), "original");
    const capability = await root(directory);
    const iterator = capability.walk("nested", {
      ...options, symlinkPolicy: "skip",
      entryFilter: async () => {
        const target = replaced === "root" ? directory : nested;
        await fs.rename(target, path.join(container, "moved"));
        await fs.mkdir(target);
        return "include";
      },
    });
    try {
      await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
    } finally {
      await iterator.return();
    }
  },
);

it.each(orders)("reports a directory replaced during a $name filter and continues with siblings", async ({ options }) => {
  const container = await tempRoot("fs-safe-root-async-filter-report-");
  const directory = path.join(container, "root");
  const broken = path.join(directory, "broken");
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, "value"), "stale");
  await fs.writeFile(path.join(directory, "healthy"), "healthy");
  const capability = await root(directory);
  const entries: RootWalkEntry[] = [];
  for await (const entry of capability.walk("", {
    ...options, symlinkPolicy: "skip", onDirectoryError: "skip-and-report",
    async entryFilter(entry) {
      if (entry.relativePath === "broken/value") {
        await fs.rename(broken, path.join(container, "moved"));
        await fs.mkdir(broken);
      }
      return "include";
    },
  })) entries.push(entry);
  expect(entries).toHaveLength(3);
  expect(entries).toContainEqual({ relativePath: "broken", kind: "directory", size: expect.any(Number) });
  expect(entries).toContainEqual({ relativePath: "healthy", kind: "file", size: 7 });
  expect(entries).toContainEqual({
    relativePath: "broken", kind: "directory-error", size: 0,
    error: expect.objectContaining({ code: "path-mismatch" }),
  });
});

it("waits for a pending filter to settle before cancellation closes its directory", async () => {
  const directory = await tempRoot("fs-safe-root-async-filter-abort-");
  await fs.writeFile(path.join(directory, "value"), "value");
  const capability = await root(directory);
  const controller = new AbortController();
  const reason = new Error("cancelled during filter");
  const entered = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<"include">();
  let closeAttempts = 0;
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeAttempts += 1;
      await close();
    });
    return handle;
  });
  const iterator = capability.walk("", {
    order: "filesystem", symlinkPolicy: "skip", signal: controller.signal,
    onDirectoryError: "skip-and-report",
    entryFilter: () => {
      entered.resolve();
      return decision.promise;
    },
  });
  const pending = iterator.next();
  const outcome = expect(pending).rejects.toBe(reason);
  try {
    await entered.promise;
    controller.abort(reason);
    await yieldToEventLoop();
    expect(closeAttempts).toBe(0);
    decision.resolve("include");
    await outcome;
    expect(closeAttempts).toBe(1);
  } finally {
    decision.resolve("include");
    await pending.catch(() => {});
    await iterator.return();
  }
});

it.each(["sorted", "filesystem"] as const)("counts async skips against the %s entry budget", async (order) => {
  const directory = await tempRoot("fs-safe-root-async-budget-");
  await Promise.all(["a", "b", "c"].map((name) => fs.writeFile(path.join(directory, name), name)));
  const capability = await root(directory);
  const filtered: string[] = [];
  const entries: RootWalkEntry[] = [];
  for await (const entry of capability.walk("", {
    order, symlinkPolicy: "skip", maxEntries: 2,
    entryFilter: async (entry) => {
      await fs.stat(path.join(directory, entry.relativePath));
      filtered.push(entry.relativePath);
      return "skip";
    },
  })) entries.push(entry);
  expect(filtered).toHaveLength(2);
  expect(entries).toEqual([{ kind: "truncated", relativePath: expect.any(String), size: 0 }]);
});

it("keeps nullish defaults and rejects invalid resolved filter decisions", async () => {
  const directory = await tempRoot("fs-safe-root-async-filter-result-");
  await fs.writeFile(path.join(directory, "value"), "value");
  const capability = await root(directory);
  for (const result of [null, undefined, "unexpected"]) {
    const iterator = capability.walk("", {
      symlinkPolicy: "skip",
      entryFilter: () => Promise.resolve(result) as never,
    });
    try {
      if (result == null) {
        expect((await iterator.next()).value).toEqual({ relativePath: "value", kind: "file", size: 5 });
        expect((await iterator.next()).done).toBe(true);
      } else {
        await expect(iterator.next()).rejects.toThrow(TypeError);
      }
    } finally {
      await iterator.return();
    }
  }
});
