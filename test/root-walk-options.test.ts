import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import type { RootWalkEntry, RootWalkOptions } from "../src/root-walk.js";
import { useRealTempDirs, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const { tempRoot: realTempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const orders = [
  { name: "sorted snapshot", options: { order: "sorted" } },
  { name: "sorted batches", options: { order: "sorted", maxEntries: 16 } },
  { name: "filesystem", options: { order: "filesystem" } },
] as const;

async function pruningTree(directory: string, files: readonly (readonly [string, string])[], marked?: string) {
  for (const [name, filename] of files) {
    await fs.mkdir(path.join(directory, name));
    await fs.writeFile(path.join(directory, name, filename), name);
  }
  if (marked) await fs.writeFile(path.join(directory, marked, "MARKER"), "marker");
  return await root(directory);
}

describe("filtering and traversal options", () => {
  it("prunes skip-subtree directories while plain skip still descends", async () => {
    const directory = await tempRoot("fs-safe-root-walk-options-");
    const capability = await pruningTree(directory, [
      ["keep", "value.txt"], ["skip", "hidden.txt"],
    ]);

    const pruned: string[] = [];
    for await (const entry of capability.walk("", {
      symlinkPolicy: "skip",
      entryFilter: (entry) =>
        entry.kind === "directory" && entry.relativePath === "skip"
          ? "skip-subtree"
          : "include",
    })) {
      pruned.push(entry.relativePath);
    }
    expect(pruned).toContain("keep/value.txt");
    expect(pruned).not.toContain("skip");
    expect(pruned).not.toContain("skip/hidden.txt");

    const filtered: string[] = [];
    for await (const entry of capability.walk("", {
      symlinkPolicy: "skip",
      entryFilter: (entry) => (entry.relativePath === "skip" ? "skip" : "include"),
    })) {
      filtered.push(entry.relativePath);
    }
    expect(filtered).not.toContain("skip");
    expect(filtered).toContain("skip/hidden.txt");
  });

  it.each([
    { name: "depth", options: { maxDepth: 1 }, marker: "a/inner" },
    { name: "entry", options: { maxEntries: 2 }, marker: "a/inner/file.txt" },
  ])("ends every generator frame after a nested $name limit", async ({ options, marker }) => {
    const directory = await tempRoot("fs-safe-root-walk-options-");
    await fs.mkdir(path.join(directory, "a", "inner"), { recursive: true });
    await fs.writeFile(path.join(directory, "a", "inner", "file.txt"), "nested");
    await fs.writeFile(path.join(directory, "z.txt"), "later sibling");
    const capability = await root(directory);
    const entries: RootWalkEntry[] = [];

    for await (const entry of capability.walk("", {
      ...options,
      symlinkPolicy: "skip",
    })) {
      entries.push(entry);
    }

    expect(entries.map(({ relativePath, kind }) => ({ relativePath, kind }))).toEqual([
      { relativePath: "a", kind: "directory" },
      { relativePath: "a/inner", kind: "directory" },
      { relativePath: marker, kind: "truncated" },
    ]);
    expect(entries.at(-1)).toEqual({ relativePath: marker, kind: "truncated", size: 0 });
  });

  it("reports failed directory subtrees and continues when requested", async () => {
    const directory = await tempRoot("fs-safe-root-walk-options-");
    await fs.mkdir(path.join(directory, "broken"));
    await fs.mkdir(path.join(directory, "healthy"));
    await fs.writeFile(path.join(directory, "healthy", "value.txt"), "healthy");
    const capability = await root(directory);
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(capability.rootReal, "broken")) {
        throw Object.assign(new Error("unreadable subtree"), { code: "EACCES" });
      }
      return await readdir(...args);
    });

    const entries: RootWalkEntry[] = [];
    for await (const entry of capability.walk("", {
      symlinkPolicy: "skip",
      onDirectoryError: "skip-and-report",
    })) {
      entries.push(entry);
    }
    expect(entries).toContainEqual({
      relativePath: "broken",
      kind: "directory-error",
      size: 0,
      error: expect.objectContaining({ code: "EACCES" }),
    });
    expect(entries).toContainEqual({
      relativePath: "healthy/value.txt",
      kind: "file",
      size: 7,
    });

    await expect(async () => {
      for await (const _entry of capability.walk("", { symlinkPolicy: "skip" })) {
        // Consume the iterator to prove the default remains fail-fast.
      }
    }).rejects.toMatchObject({ code: "EACCES" });
  });

  it.each([
    { symlinkPolicy: "unexpected" },
    { symlinkPolicy: "skip", limitBehavior: "unexpected" },
    { symlinkPolicy: "skip", onDirectoryError: "unexpected" },
    { symlinkPolicy: "skip", order: "unexpected" },
  ])("rejects invalid runtime walk policies: %j", async (options) => {
    const directory = await tempRoot("fs-safe-root-walk-options-");
    const capability = await root(directory);

    await expect(async () => {
      for await (const _entry of capability.walk("", options as never)) {
        // Consume the iterator.
      }
    }).rejects.toThrow(TypeError);
  });

  it.each(["filter", "yield"])("keeps skip policy when a child becomes a symlink during %s", async phase => {
    const container = await realTempRoot("fs-safe-root-child-symlink-swap-");
    const directory = path.join(container, "root");
    await fs.mkdir(path.join(directory, "a"), { recursive: true });
    await fs.mkdir(path.join(directory, "b"));
    await fs.writeFile(path.join(directory, "b/value"), "retained target");
    const capability = await root(directory);
    const swap = async () => {
      await fs.rename(path.join(directory, "a"), path.join(container, "moved"));
      await fs.symlink(path.join(directory, "b"), path.join(directory, "a"), process.platform === "win32" ? "junction" : "dir");
    };
    const entries: string[] = [];
    for await (const entry of capability.walk("", {
      symlinkPolicy: "skip",
      entryFilter: phase === "filter" ? async entry => {
        if (entry.relativePath === "a") await swap();
        return "include";
      } : undefined,
    })) {
      entries.push(entry.relativePath);
      if (phase === "yield" && entry.relativePath === "a") await swap();
    }
    expect(entries).not.toContain("a/value");
    expect(entries).toContain("b/value");
  });

  it.each(orders)("awaits marker pruning in $name order", async ({ options: mode }) => {
    const directory = await realTempRoot("fs-safe-root-async-prune-");
    const capability = await pruningTree(directory, [
      ["keep", "value"], ["prune", "value"], ["skip", "value"],
    ], "prune");
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
      const container = await realTempRoot("fs-safe-root-async-filter-swap-");
      const directory = path.join(container, "root");
      // Windows allows renaming the streamed directory, but not its ancestor.
      const walkPath = replaced === "root" && options.order === "filesystem" ? "" : "nested";
      const listedDirectory = path.join(directory, walkPath);
      await fs.mkdir(listedDirectory, { recursive: true });
      await fs.writeFile(path.join(listedDirectory, "value"), "original");
      const capability = await root(directory);
      const iterator = capability.walk(walkPath, {
        ...options, symlinkPolicy: "skip",
        entryFilter: async () => {
          const target = replaced === "root" ? directory : listedDirectory;
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
    const container = await realTempRoot("fs-safe-root-async-filter-report-");
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

  it("keeps nullish defaults and rejects invalid resolved filter decisions", async () => {
    const directory = await realTempRoot("fs-safe-root-async-filter-result-");
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

  it.each([
    { name: "synchronous default", makeRoot: tempRoot, files: ["one.txt", "two.txt"], budget: 1, order: undefined, asyncFilter: false },
    { name: "async sorted", makeRoot: realTempRoot, files: ["a", "b", "c"], budget: 2, order: "sorted", asyncFilter: true },
    { name: "async filesystem", makeRoot: realTempRoot, files: ["a", "b", "c"], budget: 2, order: "filesystem", asyncFilter: true },
  ] as const)("counts $name skips against the entry budget", async ({ makeRoot, files, budget, order, asyncFilter }) => {
    const directory = await makeRoot("fs-safe-root-walk-budget-");
    await Promise.all(files.map(name => fs.writeFile(path.join(directory, name), name.replace(".txt", ""))));
    const capability = await root(directory);
    const filtered: string[] = [];
    const entries: RootWalkEntry[] = [];
    const skip = (entry: RootWalkEntry) => { filtered.push(entry.relativePath); return "skip" as const; };
    for await (const entry of capability.walk("", {
      order, maxEntries: budget, symlinkPolicy: "skip",
      entryFilter: asyncFilter ? async entry => {
        await fs.stat(path.join(directory, entry.relativePath));
        return skip(entry);
      } : skip,
    })) entries.push(entry);
    expect(filtered).toHaveLength(budget);
    expect(entries).toEqual([{ relativePath: expect.any(String), kind: "truncated", size: 0 }]);
  });
});

describe("cancellation", () => {
  it("observes an abort that occurs while an empty directory is being listed", async () => {
    const directory = await tempRoot("fs-safe-root-walk-options-");
    const controller = new AbortController();
    const capability = await root(directory);
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const names = await readdir(...args);
      controller.abort();
      return names;
    });

    await expect(async () => {
      for await (const _entry of capability.walk("", {
        signal: controller.signal,
        symlinkPolicy: "skip",
      })) {
        // Consume the iterator.
      }
    }).rejects.toMatchObject({ name: "AbortError" });
  });

  it("waits for a pending filter to settle before cancellation closes its directory", async () => {
    const directory = await realTempRoot("fs-safe-root-async-filter-abort-");
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

  it.each(orders)("rejects cancellation from a synchronous $name filter before yielding", async ({ options }) => {
    const directory = await realTempRoot("fs-safe-walk-filter-abort-");
    await fs.mkdir(path.join(directory, "child"));
    await fs.writeFile(path.join(directory, "child", "value"), "value");
    const capability = await root(directory);
    const controller = new AbortController();
    const closed = vi.fn();
    const opendir = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const handle = await opendir(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed(); });
      return handle;
    });
    const filter = vi.fn(() => { controller.abort(); return "include" as const; });
    const iterator = capability.walk("", {
      ...options, symlinkPolicy: "skip", signal: controller.signal,
      onDirectoryError: "skip-and-report", entryFilter: filter,
    });
    try {
      await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
      expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
      expect(filter).toHaveBeenCalledTimes(1);
      if (options.order === "filesystem") expect(closed).toHaveBeenCalledTimes(1);
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally { await iterator.return(); }
  });
});

describe("followed-link metadata", () => {
  it.skipIf(process.platform === "win32")("filters followed file links using the target size", async () => {
    const dir = await realTempRoot("fs-safe-walk-link-size-");
    await fs.writeFile(path.join(dir, "target"), Buffer.alloc(4096, 120));
    await fs.symlink("target", path.join(dir, "alias"));
    const scoped = await root(dir);
    const entries = [];
    for await (const entry of scoped.walk("", {
      symlinkPolicy: "follow-within-root",
      entryFilter: entry => entry.relativePath === "alias" && entry.size === 4096 ? "include" : "skip",
    })) entries.push(entry);
    expect(entries).toEqual([{ relativePath: "alias", kind: "file", size: 4096 }]);
  });

  it("uses resolved directory metadata for a followed directory alias", async () => {
    const dir = await realTempRoot("fs-safe-walk-directory-size-");
    const target = path.join(dir, "target");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(dir, "alias"), process.platform === "win32" ? "junction" : "dir");
    const scoped = await root(dir);
    const expected = await scoped.stat("target");
    const entries = [];
    for await (const entry of scoped.walk("", { symlinkPolicy: "follow-within-root", maxDepth: 1 })) {
      entries.push(entry);
    }
    expect(entries).toContainEqual({ relativePath: "alias", kind: "directory", size: expected.size });
  });
});
