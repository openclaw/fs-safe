import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it.skipIf(process.platform === "win32")("filters followed file links using the target size", async () => {
  const dir = await tempRoot("fs-safe-walk-link-size-");
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
  const dir = await tempRoot("fs-safe-walk-directory-size-");
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
