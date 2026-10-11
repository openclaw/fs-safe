import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileHandleBoundedWithSize } from "../src/bounded-read.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("admitted bounded-read size hint", () => {
  it.each([0, 2, 6, Number.MAX_SAFE_INTEGER])("reads through an outdated %s-byte hint", async (initialSize) => {
    const dir = await tempRoot("fs-safe-read-size-hint-");
    const filePath = path.join(dir, "input");
    await fs.writeFile(filePath, "abcdef");
    const handle = await fs.open(filePath, "r");
    try {
      expect(await readFileHandleBoundedWithSize(handle, 6, initialSize)).toEqual(Buffer.from("abcdef"));
    } finally {
      await handle.close();
    }
  });

  it.each([2, 4, 8])("enforces the byte cap after growth from a %s-byte hint", async (initialSize) => {
    const dir = await tempRoot("fs-safe-read-size-growth-");
    const filePath = path.join(dir, "input");
    await fs.writeFile(filePath, "abcdefgh");
    const handle = await fs.open(filePath, "r");
    try {
      await expect(readFileHandleBoundedWithSize(handle, 6, initialSize)).rejects.toMatchObject({ code: "too-large" });
      const next = Buffer.alloc(1);
      expect(fsSync.readSync(handle.fd, next, 0, 1, null)).toBe(1);
      expect(next.toString()).toBe("h");
    } finally {
      await handle.close();
    }
  });

  it("retains the fresh size observation after the read", async () => {
    const dir = await tempRoot("fs-safe-read-size-fresh-");
    const filePath = path.join(dir, "input");
    await fs.writeFile(filePath, "abcd");
    const handle = await fs.open(filePath, "r");
    const stat = vi.spyOn(fsSync, "fstatSync");
    try {
      expect(await readFileHandleBoundedWithSize(handle, 4, 4)).toEqual(Buffer.from("abcd"));
      expect(stat).toHaveBeenCalledTimes(1);
      expect(stat).toHaveBeenCalledWith(handle.fd);
    } finally {
      await handle.close();
    }
  });
});
