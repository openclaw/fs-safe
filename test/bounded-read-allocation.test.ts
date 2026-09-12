import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileDescriptorBounded, readFileDescriptorBoundedSync, readFileHandleBounded } from "../src/bounded-read.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(content: string) {
  const dir = await tempRoot("fs-safe-read-allocation-");
  const filePath = path.join(dir, "input");
  await fs.writeFile(filePath, content);
  return filePath;
}

describe("bounded read allocation", () => {
  it.each(["handle", "descriptor", "sync"] as const)("does not allocate a huge size hint before reaching EOF (%s)", async (reader) => {
    const filePath = await fixture("");
    const handle = await fs.open(filePath, "r");
    const stat = fsSync.fstatSync(handle.fd);
    const hintedStat = Object.assign(Object.create(stat), { size: Number.MAX_SAFE_INTEGER });
    vi.spyOn(fsSync, "fstatSync").mockReturnValue(hintedStat);
    const allocate = Buffer.allocUnsafe;
    let largestAllocation = 0;
    vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
      largestAllocation = Math.max(largestAllocation, size);
      // Make a speculative OOM deterministic without allocating large memory.
      if (size > 16 * 1024 * 1024 + 1) throw new RangeError("oversized speculative allocation");
      return allocate(size);
    });
    try {
      const result = reader === "handle" ? await readFileHandleBounded(handle, Infinity)
        : reader === "descriptor" ? await readFileDescriptorBounded(handle.fd, Infinity)
          : readFileDescriptorBoundedSync(handle.fd, Infinity);
      expect(result.length).toBe(0);
      expect(largestAllocation).toBeLessThanOrEqual(16 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
  });

  it.each([0, 4, 128 * 1024, 1024 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024])("reads a %s-byte regular file synchronously without a second read or a copy", async (size) => {
    const filePath = await fixture("x".repeat(size));
    const fd = fsSync.openSync(filePath, "r");
    const read = vi.spyOn(fsSync, "readSync");
    const concat = vi.spyOn(Buffer, "concat");
    try {
      const result = readFileDescriptorBoundedSync(fd, size);
      expect(result.equals(Buffer.alloc(size, "x"))).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(concat).not.toHaveBeenCalled();
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it.each([false, true])("continues synchronous short reads and enforces the cap after growth (%s)", async (grow) => {
    const filePath = await fixture("abcd");
    const fd = fsSync.openSync(filePath, "r");
    const originalRead = fsSync.readSync;
    vi.spyOn(fsSync, "readSync").mockImplementationOnce((descriptor, buffer, offset, _length, position) => {
      if (grow) fsSync.appendFileSync(filePath, "efgh");
      return originalRead(descriptor, buffer, offset, 1, position);
    });
    try {
      if (grow) {
        expect(() => readFileDescriptorBoundedSync(fd, 4)).toThrow(expect.objectContaining({ code: "too-large" }));
        const next = Buffer.alloc(1);
        originalRead(fd, next, 0, 1, null);
        expect(next.toString()).toBe("f");
      } else {
        expect(readFileDescriptorBoundedSync(fd, 4).toString()).toBe("abcd");
      }
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it("starts at the current synchronous descriptor offset and retains ownership", async () => {
    const filePath = await fixture("prefix-tail");
    const fd = fsSync.openSync(filePath, "r");
    try {
      fsSync.readSync(fd, Buffer.alloc(7), 0, 7, null);
      expect(readFileDescriptorBoundedSync(fd, 4).toString()).toBe("tail");
      expect(fsSync.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it.each(["handle", "sync"] as const)("reads beyond the initial allocation and enforces an exact large cap (%s)", async (reader) => {
    const content = "y".repeat(32 * 1024 * 1024);
    const filePath = await fixture(content);
    const handle = await fs.open(filePath, "r");
    try {
      const result = reader === "handle" ? await readFileHandleBounded(handle, content.length)
        : readFileDescriptorBoundedSync(handle.fd, content.length);
      expect(result.toString()).toBe(content);
    } finally {
      await handle.close();
    }
  });
});
