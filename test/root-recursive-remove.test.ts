import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const directoryLink = process.platform === "win32" ? "junction" : "dir";
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const directory = await tempRoot("fs-safe-recursive-remove-");
  await fs.mkdir(path.join(directory, "tree", "nested"), { recursive: true });
  await fs.writeFile(path.join(directory, "tree", "nested", "value"), "original");
  return { directory, scoped: await root(directory) };
}

it("removes a tree only when recursion is requested and keeps siblings and hardlink data", async () => {
  const { directory, scoped } = await fixture();
  await fs.link(path.join(directory, "tree/nested/value"), path.join(directory, "retained"));
  await expect(scoped.remove("tree")).rejects.toMatchObject({ code: "not-empty" });
  await scoped.remove("tree", { recursive: true, maxEntries: 3, maxDepth: 2 });
  expect(await fs.readdir(directory)).toEqual(["retained"]);
  expect(await fs.readFile(path.join(directory, "retained"), "utf8")).toBe("original");
});

it.each(["", ".", "..", "../outside"])("never removes root or an escape through %j", async relative => {
  const { directory, scoped } = await fixture();
  await expect(scoped.remove(relative, { recursive: true, force: true })).rejects.toBeTruthy();
  expect(await fs.readFile(path.join(directory, "tree/nested/value"), "utf8")).toBe("original");
});

it.each(["paths", "prefixes"] as const)("rejects denied descendants before any deletion (%s)", async kind => {
  const { directory } = await fixture();
  await fs.writeFile(path.join(directory, "tree/sibling"), "keep");
  const scoped = await root(directory, { denyMutations: { [kind]: [path.join(directory, "tree/nested/value")] } });
  await expect(scoped.remove("tree", { recursive: true, denyMutations: { paths: [] } }))
    .rejects.toMatchObject({ code: "denied-path" });
  expect(await fs.readFile(path.join(directory, "tree/sibling"), "utf8")).toBe("keep");
  expect(await fs.readFile(path.join(directory, "tree/nested/value"), "utf8")).toBe("original");
});

it.each([undefined, "reject", "follow-parents-within-root"] as const)(
  "never follows descendant symlinks with mutation policy %s", async mutationSymlinks => {
    const directory = await tempRoot("fs-safe-recursive-links-");
    const outside = await tempRoot("fs-safe-recursive-outside-");
    await fs.writeFile(path.join(outside, "sentinel"), "outside");
    await fs.mkdir(path.join(directory, "tree"));
    await fs.symlink(outside, path.join(directory, "tree/escape"), directoryLink);
    const scoped = await root(directory);
    const pending = scoped.remove("tree", { recursive: true, mutationSymlinks });
    if (mutationSymlinks === undefined) {
      await pending;
      expect(await fs.readdir(directory)).toEqual([]);
    } else {
      await expect(pending).rejects.toMatchObject({ code: "symlink" });
      expect((await fs.lstat(path.join(directory, "tree/escape"))).isSymbolicLink()).toBe(true);
    }
    expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("outside");
  },
);

it("follows only allowed input parents and rejects a final directory alias", async () => {
  const { directory, scoped } = await fixture();
  await fs.symlink(path.join(directory, "tree"), path.join(directory, "alias"), directoryLink);
  const options = { recursive: true, mutationSymlinks: "follow-parents-within-root" as const };
  await expect(scoped.remove("alias", options)).rejects.toMatchObject({ code: "symlink" });
  await scoped.remove("alias/nested", options);
  expect(await fs.readdir(path.join(directory, "tree"))).toEqual([]);
  expect((await fs.lstat(path.join(directory, "alias"))).isSymbolicLink()).toBe(true);
});

itWin32.each([
  { kind: "file", stored: "Parent/value", relative: "parent/value" },
  { kind: "directory", stored: "Tree", relative: "tree" },
])("accepts Windows casing for a $kind target and its parents", async ({ kind, stored, relative }) => {
  const directory = await tempRoot("fs-safe-remove-case-");
  const target = path.join(directory, stored);
  await fs.mkdir(kind === "file" ? path.dirname(target) : target, { recursive: true });
  await fs.writeFile(kind === "file" ? target : path.join(target, "value"), "value");
  const scoped = await root(directory);
  await scoped.remove(relative, { recursive: true, mutationSymlinks: "reject" });
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

itPosix("keeps POSIX admission spelling case-sensitive", async () => {
  const directory = await tempRoot("fs-safe-remove-posix-case-");
  await fs.mkdir(path.join(directory, "Tree"));
  await fs.writeFile(path.join(directory, "Tree/value"), "preserve");
  const scoped = await root(directory);
  await expect(scoped.remove("tree", { recursive: true })).rejects.toBeTruthy();
  expect(await fs.readFile(path.join(directory, "Tree/value"), "utf8")).toBe("preserve");
});

it.each([0, 1, 3])("counts the target and limits observed entries to %i", async maxEntries => {
  const directory = await tempRoot("fs-safe-recursive-entry-budget-");
  const tree = path.join(directory, "tree");
  await fs.mkdir(tree);
  await Promise.all(["a", "b", "c", "d"].map(name => fs.writeFile(path.join(tree, name), name)));
  const scoped = await root(directory);
  const observed = new Set<string>();
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (path.dirname(String(args[0])) === tree) observed.add(String(args[0]));
    return lstat(...args);
  });
  await expect(scoped.remove("tree", { recursive: true, maxEntries })).rejects.toMatchObject({ code: "too-large" });
  expect(observed.size).toBe(Math.max(0, maxEntries - 1));
  expect(await fs.readdir(tree)).toHaveLength(4 - Math.max(0, maxEntries - 1));
});

it("permits an empty directory at the depth limit but leaves deeper entries untouched", async () => {
  const { directory, scoped } = await fixture();
  await expect(scoped.remove("tree", { recursive: true, maxDepth: 1 })).rejects.toMatchObject({ code: "too-large" });
  expect(await fs.readFile(path.join(directory, "tree/nested/value"), "utf8")).toBe("original");
  await fs.mkdir(path.join(directory, "empty"));
  await scoped.remove("empty", { recursive: true, maxDepth: 0, maxEntries: 1 });
  await expect(fs.stat(path.join(directory, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("bounds wide-tree metadata work without rescanning remaining siblings", async () => {
  const directory = await tempRoot("fs-safe-recursive-wide-");
  const tree = path.join(directory, "tree");
  const width = 256;
  await fs.mkdir(tree);
  await Promise.all(Array.from({ length: width }, (_, index) => fs.writeFile(path.join(tree, `file-${index}`), "value")));
  const scoped = await root(directory);
  const metadata = vi.spyOn(fsSync, "lstatSync");
  await scoped.remove("tree", { recursive: true, maxEntries: width + 1 });
  // Allow constant guard overhead per entry, but reject quadratic sibling admission.
  expect(metadata.mock.calls.length).toBeLessThan(width * 40);
  expect(await fs.readdir(directory)).toEqual([]);
});

it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid removal budgets %s before I/O", async value => {
  const { directory, scoped } = await fixture();
  for (const name of ["maxEntries", "maxDepth"] as const) {
    await expect(scoped.remove("tree", { recursive: true, [name]: value })).rejects.toBeInstanceOf(RangeError);
  }
  await expect(scoped.remove("tree", { maxEntries: 5 })).rejects.toBeInstanceOf(TypeError);
  expect(await fs.readFile(path.join(directory, "tree/nested/value"), "utf8")).toBe("original");
});

it.each([false, true])("force suppresses only missing targets (recursive=%s)", async recursive => {
  const { directory, scoped } = await fixture();
  for (const relative of ["missing", "missing/child"]) {
    await scoped.remove(relative, { recursive, force: true });
    await expect(scoped.remove(relative, { recursive })).rejects.toMatchObject({ code: "not-found" });
  }
  await fs.rename(directory, `${directory}.saved`);
  try {
    await expect(scoped.remove("missing", { recursive, force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  } finally {
    await fs.rename(`${directory}.saved`, directory);
  }
});
