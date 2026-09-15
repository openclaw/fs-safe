import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readFileDescriptorBounded,
  readFileDescriptorBoundedSync,
  readFileHandleBounded,
} from "../src/bounded-read.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function shortVirtualReads(handle: FileHandle, initialSize: number) {
  const stat = fsSync.fstatSync(handle.fd);
  const observe = vi.spyOn(fsSync, "fstatSync").mockReturnValue(Object.assign(Object.create(stat), { size: 0 }));
  if (initialSize > 0) observe.mockReturnValueOnce(Object.assign(Object.create(stat), { size: initialSize }));
  const handleRead = handle.read.bind(handle);
  vi.spyOn(handle, "read").mockImplementation((buffer, offset, length, position) =>
    handleRead(buffer, offset, Math.min(length, 1), position));
  const descriptorRead = fsSync.read;
  vi.spyOn(fsSync, "read").mockImplementation(((...args: unknown[]) => {
    args[3] = Math.min(args[3] as number, 1);
    return Reflect.apply(descriptorRead, fsSync, args);
  }) as typeof fsSync.read);
  const syncRead = fsSync.readSync;
  vi.spyOn(fsSync, "readSync").mockImplementation((fd, buffer, offset, length, position) =>
    syncRead(fd, buffer, offset, Math.min(length, 1), position));
}

describe.each(["handle", "descriptor", "sync"] as const)("zero-size virtual reads (%s)", reader => {
  it.each([
    { maxBytes: 6, overflow: false, initialSize: 0 },
    { maxBytes: 64 * 1024, overflow: false, initialSize: 0 },
    { maxBytes: 4, overflow: true, initialSize: 0 },
    { maxBytes: 0, overflow: true, initialSize: 0 },
    ...(reader === "sync" ? [] : [
      { maxBytes: 6, overflow: false, initialSize: 6 },
      { maxBytes: 4, overflow: true, initialSize: 6 },
    ]),
  ])("honors cursor and $maxBytes-byte cap across short reads (initial size: $initialSize)", async ({ maxBytes, overflow, initialSize }) => {
    const dir = await tempRoot("fs-safe-virtual-read-");
    const filePath = path.join(dir, "input");
    await fs.writeFile(filePath, "prefix:abcdef");
    const handle = await fs.open(filePath, "r");
    const realRead = fsSync.readSync;
    const realStat = fsSync.fstatSync;
    try {
      expect(realRead(handle.fd, Buffer.alloc(7), 0, 7, null)).toBe(7);
      shortVirtualReads(handle, initialSize);
      const read = async () => reader === "handle" ? await readFileHandleBounded(handle, maxBytes)
        : reader === "descriptor" ? await readFileDescriptorBounded(handle.fd, maxBytes)
          : readFileDescriptorBoundedSync(handle.fd, maxBytes);
      if (overflow) await expect(read()).rejects.toMatchObject({ code: "too-large" });
      else await expect(read()).resolves.toEqual(Buffer.from("abcdef"));

      expect(realStat(handle.fd).isFile()).toBe(true);
      const next = Buffer.alloc(1);
      expect(realRead(handle.fd, next, 0, 1, null)).toBe(overflow ? 1 : 0);
      if (overflow) expect(next.toString()).toBe("abcdef"[maxBytes + 1]);
    } finally {
      await handle.close();
    }
  });
});
