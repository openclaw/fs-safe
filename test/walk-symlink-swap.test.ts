import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkDirectory, walkDirectorySync, type WalkDirectoryEntry } from "../src/walk.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const linkType = process.platform === "win32" ? "junction" : "dir";

async function fixture() {
  const parent = await tempRoot("fs-safe-walk-swap-");
  const root = path.join(parent, "root");
  const child = path.join(root, "branch");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(child, "inside-only.txt"), "inside");
  fs.writeFileSync(path.join(outside, "outside-only.txt"), "outside");
  return {
    root,
    alias: path.join(parent, "alias"),
    swap(entry: WalkDirectoryEntry) {
      if (entry.relativePath !== "branch") return;
      fs.renameSync(child, path.join(parent, "original-branch"));
      fs.symlinkSync(outside, child, linkType);
    },
  };
}

describe("standalone walk child symlink admission", () => {
  for (const callback of ["include", "descend"] as const) {
    for (const symlinks of ["skip", "include", "follow"] as const) {
      it(`honors ${symlinks} after a synchronous ${callback} swaps the child`, async () => {
        const tree = await fixture();
        const result = walkDirectorySync(tree.root, {
          symlinks,
          [callback]: (entry: WalkDirectoryEntry) => { tree.swap(entry); return true; },
        });
        expect(result.entries.some(entry => entry.name === "outside-only.txt")).toBe(symlinks === "follow");
        expect(result.failedDirs).toEqual([]);
      });

      it(`honors ${symlinks} after an awaited ${callback} swaps the child`, async () => {
        const tree = await fixture();
        const result = await walkDirectory(tree.root, {
          symlinks,
          [callback]: async (entry: WalkDirectoryEntry) => {
            await Promise.resolve();
            tree.swap(entry);
            return true;
          },
        });
        expect(result.entries.some(entry => entry.name === "outside-only.txt")).toBe(symlinks === "follow");
        expect(result.failedDirs).toEqual([]);
      });
    }
  }

  it("retains explicitly selected root aliases under skip", async () => {
    const tree = await fixture();
    fs.symlinkSync(tree.root, tree.alias, linkType);
    expect(walkDirectorySync(tree.alias).entries.some(entry => entry.name === "inside-only.txt")).toBe(true);
    expect((await walkDirectory(tree.alias)).entries.some(entry => entry.name === "inside-only.txt")).toBe(true);
  });
});
