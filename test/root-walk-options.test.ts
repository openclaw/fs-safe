import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { root } from "../src/root.js";
import { walkRoot, type RootWalkEntry } from "../src/root-walk.js";
import type { DirEntry } from "../src/types.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-root-walk-options-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

it("prunes skip-subtree directories while plain skip still descends", async () => {
  const directory = await tempRoot();
  await fs.mkdir(path.join(directory, "keep"));
  await fs.mkdir(path.join(directory, "skip"));
  await fs.writeFile(path.join(directory, "keep", "value.txt"), "keep");
  await fs.writeFile(path.join(directory, "skip", "hidden.txt"), "skip");
  const capability = await root(directory);

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

it("counts skipped entries against the traversal budget", async () => {
  const directory = await tempRoot();
  await fs.writeFile(path.join(directory, "one.txt"), "one");
  await fs.writeFile(path.join(directory, "two.txt"), "two");
  const capability = await root(directory);
  const filtered: string[] = [];
  const entries: RootWalkEntry[] = [];

  for await (const entry of capability.walk("", {
    maxEntries: 1,
    symlinkPolicy: "skip",
    entryFilter: (candidate) => {
      filtered.push(candidate.relativePath);
      return "skip";
    },
  })) {
    entries.push(entry);
  }

  expect(filtered).toHaveLength(1);
  expect(entries).toEqual([
    { relativePath: expect.any(String), kind: "truncated", size: 0 },
  ]);
});

it("reports failed directory subtrees and continues when requested", async () => {
  const directory = await tempRoot();
  await fs.mkdir(path.join(directory, "broken"));
  await fs.mkdir(path.join(directory, "healthy"));
  await fs.writeFile(path.join(directory, "healthy", "value.txt"), "healthy");
  const capability = await root(directory);
  const list = capability.list.bind(capability) as (
    relativePath: string,
    options: { withFileTypes: true },
  ) => Promise<DirEntry[]>;
  const walkingRoot = {
    rootReal: capability.rootReal,
    async list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]> {
      if (relativePath === "broken") {
        throw Object.assign(new Error("unreadable subtree"), { code: "EACCES" });
      }
      return await list(relativePath, options);
    },
  };

  const entries: RootWalkEntry[] = [];
  for await (const entry of walkRoot(walkingRoot, "", {
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
    for await (const _entry of walkRoot(walkingRoot, "", { symlinkPolicy: "skip" })) {
      // Consume the iterator to prove the default remains fail-fast.
    }
  }).rejects.toMatchObject({ code: "EACCES" });
});

it("observes an abort that occurs while an empty directory is being listed", async () => {
  const directory = await tempRoot();
  const controller = new AbortController();
  const capability = await root(directory);
  const walkingRoot = {
    rootReal: capability.rootReal,
    async list(): Promise<DirEntry[]> {
      controller.abort();
      return [];
    },
  };

  await expect(async () => {
    for await (const _entry of walkRoot(walkingRoot, "", {
      signal: controller.signal,
      symlinkPolicy: "skip",
    })) {
      // Consume the iterator.
    }
  }).rejects.toMatchObject({ name: "AbortError" });
});

it.each([
  { symlinkPolicy: "unexpected" },
  { symlinkPolicy: "skip", limitBehavior: "unexpected" },
  { symlinkPolicy: "skip", onDirectoryError: "unexpected" },
])("rejects invalid runtime walk policies: %j", async (options) => {
  const directory = await tempRoot();
  const capability = await root(directory);

  await expect(async () => {
    for await (const _entry of capability.walk("", options as never)) {
      // Consume the iterator.
    }
  }).rejects.toThrow(TypeError);
});
