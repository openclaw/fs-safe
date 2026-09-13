import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function observeChildMetadata(directory: string, afterRead?: (name: string) => void): string[] {
  const names: string[] = [];
  const observe = (candidate: fsSync.PathLike) => {
    if (path.dirname(String(candidate)) === directory) names.push(path.basename(String(candidate)));
  };
  const sync = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    observe(args[0]);
    const result = sync(...args);
    if (path.dirname(String(args[0])) === directory) afterRead?.(path.basename(String(args[0])));
    return result;
  });
  const lstatAsync = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    observe(args[0]);
    const result = await lstatAsync(...args);
    if (path.dirname(String(args[0])) === directory) afterRead?.(path.basename(String(args[0])));
    return result;
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

it("rejects a directory replaced across filesystem iterator yields", async () => {
  const directory = await tempRoot("fs-safe-walk-directory-swap-");
  const nested = path.join(directory, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "a"), "original");
  await fs.writeFile(path.join(nested, "b"), "original");
  const capability = await root(directory);
  const iterator = capability.walk("nested", { order: "filesystem", symlinkPolicy: "skip", maxEntries: 2 });
  expect((await iterator.next()).value).toMatchObject({ kind: "file", size: 8 });
  await fs.rename(nested, path.join(directory, "moved"));
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "a"), "replacement");
  await fs.writeFile(path.join(nested, "b"), "replacement");
  await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
});

it.for(["sorted", "filesystem"] as const)("preserves filesystem-supported case aliases in %s order", async (order, context) => {
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
  let firstName: string | undefined;
  for await (const entry of capability.walk("", { order: "filesystem", symlinkPolicy: "skip", maxEntries: 2 })) {
    expect(entry).toMatchObject({ kind: "file", size: 1 });
    expect(["a", "z"]).toContain(entry.relativePath);
    firstName = entry.relativePath;
    break;
  }
  expect(observed).toEqual([firstName]);
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

it("stops metadata batches at followed directory symlinks before spending descendant budget", async () => {
  const directory = await tempRoot("fs-safe-walk-link-budget-");
  const target = path.join(directory, "target");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "child"), "value");
  await fs.symlink(target, path.join(directory, "a-alias"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(directory, "m-sibling"), "unused");
  const capability = await root(directory);
  const observed = observeChildMetadata(directory);
  const entries = [];
  for await (const entry of capability.walk("", { symlinkPolicy: "follow-within-root", maxEntries: 2 })) entries.push(entry);
  expect(entries.map(({ relativePath, kind }) => ({ relativePath, kind }))).toEqual([
    { relativePath: "a-alias", kind: "directory" },
    { relativePath: "a-alias/child", kind: "file" },
    { relativePath: "m-sibling", kind: "truncated" },
  ]);
  expect(observed).not.toContain("m-sibling");
});

it("stops at skipped symlinks before observing the following batch", async () => {
  const directory = await tempRoot("fs-safe-walk-skipped-link-batch-");
  const target = path.join(directory, "target");
  await fs.mkdir(target);
  await fs.symlink(target, path.join(directory, "a-alias"), process.platform === "win32" ? "junction" : "dir");
  const sibling = path.join(directory, "m-sibling");
  await fs.writeFile(sibling, "old");
  const capability = await root(directory);
  observeChildMetadata(directory, (name) => {
    if (name === "a-alias") queueMicrotask(() => fsSync.writeFileSync(sibling, "updated"));
  });
  const entries = [];
  for await (const entry of capability.walk("", { symlinkPolicy: "skip", maxEntries: 2 })) entries.push(entry);
  expect(entries).toEqual([
    { relativePath: "m-sibling", kind: "file", size: 7 },
    { relativePath: "target", kind: "truncated", size: 0 },
  ]);
});

it.each([undefined, 2])("reuses prepared sorted metadata with an entry budget of %s", async (maxEntries) => {
  const directory = await tempRoot("fs-safe-walk-snapshot-");
  await fs.writeFile(path.join(directory, "a"), "a");
  await fs.writeFile(path.join(directory, "b"), "before");
  const capability = await root(directory);
  const iterator = capability.walk("", { symlinkPolicy: "skip", maxEntries });
  expect((await iterator.next()).value).toEqual({ relativePath: "a", kind: "file", size: 1 });
  await fs.writeFile(path.join(directory, "b"), "changed after the listing");
  expect((await iterator.next()).value).toEqual({ relativePath: "b", kind: "file", size: 6 });
  expect((await iterator.next()).done).toBe(true);
});

it.each(["between-yields", "during-metadata", "symlink-root", "ancestor-alias"] as const)(
  "retains root replacement rejection %s with an identical listing receipt",
  async (phase) => {
    const container = await tempRoot("fs-safe-walk-root-receipt-");
    const directory = path.join(container, "parent", "root");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "a"), "a");
    await fs.writeFile(path.join(directory, "b"), "b");
    const original = await fs.stat(directory, { bigint: true });
    const capability = await root(directory);
    const replace = async () => {
      if (phase === "ancestor-alias") {
        const parent = path.dirname(directory);
        const moved = path.join(container, "moved-parent");
        await fs.rename(parent, moved);
        await fs.symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
        return;
      }
      const moved = path.join(container, "moved");
      await fs.rename(directory, moved);
      if (phase === "symlink-root") {
        await fs.symlink(moved, directory, process.platform === "win32" ? "junction" : "dir");
      } else {
        await fs.mkdir(directory);
      }
    };
    const iterator = capability.walk("", {
      order: phase === "during-metadata" ? "sorted" : "filesystem", symlinkPolicy: "skip", maxEntries: 2,
    });
    try {
      if (phase === "during-metadata") {
        observeChildMetadata(directory, (name) => {
          if (name === "a") {
            fsSync.renameSync(directory, path.join(container, "moved"));
            fsSync.mkdirSync(directory);
            fsSync.writeFileSync(path.join(directory, "b"), "replacement");
          }
        });
      } else {
        const first = (await iterator.next()).value;
        expect(first).toMatchObject({ kind: "file", size: 1 });
        expect(["a", "b"]).toContain(first.relativePath);
        try {
          await replace();
        } catch (error) {
          const failure = error as NodeJS.ErrnoException;
          if (phase !== "ancestor-alias" || process.platform !== "win32" ||
            failure.syscall !== "rename" || !["EPERM", "EACCES"].includes(failure.code ?? "")) throw error;
          expect(failure).toMatchObject({ code: expect.stringMatching(/^(?:EPERM|EACCES)$/), syscall: "rename" });
          const unchanged = await fs.stat(directory, { bigint: true });
          expect({ dev: unchanged.dev, ino: unchanged.ino }).toEqual({ dev: original.dev, ino: original.ino });
          expect(await fs.readdir(container)).toEqual(["parent"]);
          expect((await iterator.next()).value).toEqual({
            relativePath: first.relativePath === "a" ? "b" : "a", kind: "file", size: 1,
          });
          expect((await iterator.next()).done).toBe(true);
          return;
        }
      }
      await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
    } finally {
      await iterator.return();
    }
  },
);

it("counts failed metadata reads before reporting a skipped subtree", async () => {
  const directory = await tempRoot("fs-safe-walk-failed-entry-budget-");
  await fs.mkdir(path.join(directory, "a"));
  await fs.writeFile(path.join(directory, "a", "a-good"), "value");
  await fs.writeFile(path.join(directory, "a", "b-broken"), "value");
  await fs.writeFile(path.join(directory, "z"), "unused");
  const capability = await root(directory);
  observeChildMetadata(path.join(directory, "a"), (name) => {
    if (name === "b-broken") {
      throw Object.assign(new Error("metadata unavailable"), { code: "EACCES" });
    }
  });
  const entries = [];
  for await (const entry of capability.walk("", {
    symlinkPolicy: "skip", maxEntries: 3, onDirectoryError: "skip-and-report",
  })) entries.push(entry);
  expect(entries.map(({ relativePath, kind }) => ({ relativePath, kind }))).toEqual([
    { relativePath: "a", kind: "directory" },
    { relativePath: "a/a-good", kind: "file" },
    { relativePath: "a", kind: "directory-error" },
    { relativePath: "z", kind: "truncated" },
  ]);
});

it("lets event-loop cancellation interrupt a complete budgeted scan before the unused suffix", async () => {
  const directory = await tempRoot("fs-safe-walk-timer-");
  const count = 256;
  await Promise.all(Array.from({ length: count }, (_, index) =>
    fs.writeFile(path.join(directory, String(index).padStart(3, "0")), "value")));
  const capability = await root(directory);
  const observed = observeChildMetadata(directory);
  const controller = new AbortController();
  const reason = new Error("cancelled from a timer");
  let timer: ReturnType<typeof setImmediate> | undefined;
  let yielded = 0;
  const consume = async () => {
    for await (const _entry of capability.walk("", {
      symlinkPolicy: "skip", maxEntries: count, signal: controller.signal,
    })) {
      yielded += 1;
      timer ??= setImmediate(() => controller.abort(reason));
    }
  };
  try {
    await expect(consume()).rejects.toBe(reason);
    expect(yielded).toBeGreaterThan(0);
    expect(observed.length).toBeLessThan(count);
  } finally {
    clearImmediate(timer);
  }
});
