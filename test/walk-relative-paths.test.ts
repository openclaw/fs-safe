import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { walkDirectory, walkDirectorySync } from "../src/walk.js";

const tempDirs: string[] = [];
const walkers = [
  { name: "async", walk: walkDirectory },
  { name: "sync", walk: walkDirectorySync },
];

async function fixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-walk-paths-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it.each(walkers)("$name preserves nested lexical names from a relative root", async ({ walk }) => {
  const directory = await fixture();
  const nested = path.join(".hidden", "nested space", "café");
  const name = process.platform === "win32" ? "value.txt" : "value\\literal.txt";
  await fs.mkdir(path.join(directory, nested), { recursive: true });
  await fs.writeFile(path.join(directory, nested, name), "value");

  const result = await walk(`${path.relative(process.cwd(), directory)}${path.sep}.`, {
    include: (entry) => entry.kind === "file",
  });
  expect(result.entries).toEqual([
    expect.objectContaining({
      name,
      path: path.join(directory, nested, name),
      relativePath: path.join(nested, name),
      depth: 4,
      kind: "file",
    }),
  ]);
  expect(result.scannedEntryCount).toBe(4);
  expect(result.failedDirs).toEqual([]);
  expect(result.truncated).toBe(false);
});

it.each(walkers)("$name keeps followed directory paths relative to the supplied alias", async ({ walk }) => {
  const directory = await fixture();
  const scan = path.join(directory, "scan");
  const target = path.join(directory, "target");
  const alias = path.join(directory, "alias");
  await fs.mkdir(scan);
  await fs.mkdir(path.join(target, "nested"), { recursive: true });
  await fs.writeFile(path.join(target, "nested", "file.txt"), "value");
  await fs.symlink(scan, alias, "junction");
  await fs.symlink(target, path.join(scan, "linked"), "junction");

  const result = await walk(alias, { symlinks: "follow" });
  expect(result.entries.map(({ relativePath }) => relativePath)).toEqual([
    "linked",
    path.join("linked", "nested"),
    path.join("linked", "nested", "file.txt"),
  ]);
  expect(result.entries.at(-1)?.path).toBe(path.join(alias, "linked", "nested", "file.txt"));
  expect(result.failedDirs).toEqual([]);
  expect(result.truncated).toBe(false);
});

it.each(walkers)("$name does not let callback result mutation redirect descendant paths", async ({ walk }) => {
  const directory = await fixture();
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "file.txt"), "value");

  const result = await walk(directory, {
    include: (entry) => {
      if (entry.kind === "directory") {
        entry.relativePath = "changed by callback";
        return false;
      }
      return true;
    },
  });
  expect(result.entries.map(({ relativePath }) => relativePath)).toEqual([
    path.join("nested", "file.txt"),
  ]);
});
