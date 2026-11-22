import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { tempFile, withTempFile } from "../src/temp-target.js";
import { itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

itWin32.each([[259, 220], [260, 220], [300, 220], [340, 280]])(
  "creates and cleans a %i-character temp directory with root length >= %i",
  async (directoryLength, rootLength) => {
    const base = await tempRoot("fs-safe-long-temp-");
    let rootDir = base;
    while (rootDir.length < rootLength) rootDir = path.join(rootDir, "nested-directory");
    await fs.mkdir(rootDir, { recursive: true });
    // tempFile adds a hyphen and mkdtemp's six random characters.
    const prefix = "x".repeat(directoryLength - rootDir.length - 1 - 7);
    const target = await tempFile({ rootDir, prefix, fileName: "payload.txt" });
    try {
      expect(target.dir).toHaveLength(directoryLength);
      expect(path.dirname(target.dir)).toBe(rootDir);
      expect(target.dir.startsWith("\\\\?\\")).toBe(false);
      expect(target.file("other.txt")).toBe(path.join(target.dir, "other.txt"));
      await fs.writeFile(target.path, "owned");
      expect(await fs.readFile(target.path, "utf8")).toBe("owned");
    } finally {
      await target.cleanup();
    }
    await expect(fs.lstat(target.dir)).rejects.toMatchObject({ code: "ENOENT" });

    let scopedPath = "";
    await expect(withTempFile({ rootDir, prefix }, async (file) => {
      scopedPath = file;
      await fs.writeFile(file, "scoped");
      return fs.readFile(file, "utf8");
    })).resolves.toBe("scoped");
    await expect(fs.lstat(path.dirname(scopedPath))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
