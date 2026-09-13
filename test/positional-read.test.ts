import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileWindowFully, readFileWindowFullySync } from "../src/advanced.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(): Promise<FileHandle> {
  const directory = await tempRoot("fs-safe-positional-read-");
  const file = path.join(directory, "input.txt");
  await fs.writeFile(file, "abcdefgh");
  return await fs.open(file, "r");
}

for (const mode of ["async", "sync"] as const) {
  const readWindow = (handle: FileHandle, buffer: Buffer, position: number) => mode === "async"
    ? readFileWindowFully(handle, buffer, position)
    : readFileWindowFullySync(handle.fd, buffer, position);

  describe(`positional reads (${mode})`, () => {
    it("completes short reads into a buffer slice without moving the descriptor cursor", async () => {
      const handle = await fixture();
      try {
        await handle.read(Buffer.alloc(1), 0, 1, null);
        if (mode === "async") {
          const original = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementationOnce(async (buffer, offset, _length, position) =>
            await original(buffer, offset, 1, position));
        } else {
          const original = fsSync.readSync.bind(fsSync);
          vi.spyOn(fsSync, "readSync").mockImplementationOnce((fd, buffer, offset, _length, position) =>
            original(fd, buffer, offset, 1, position));
        }
        const backing = Buffer.alloc(6, ".");
        expect(await readWindow(handle, backing.subarray(1, 5), 2)).toBe(4);
        expect(backing.toString()).toBe(".cdef.");
        const next = Buffer.alloc(1);
        expect((await handle.read(next, 0, 1, null)).bytesRead).toBe(1);
        expect(next.toString()).toBe("b");
      } finally {
        await handle.close();
      }
    });

    it.each([6, 8, 2 ** 32])("stops at EOF from position %s and leaves the unread suffix intact", async (position) => {
      const handle = await fixture();
      try {
        const buffer = Buffer.alloc(4, ".");
        const count = await readWindow(handle, buffer, position);
        expect(count).toBe(position === 6 ? 2 : 0);
        expect(buffer.toString()).toBe(position === 6 ? "gh.." : "....");
      } finally {
        await handle.close();
      }
    });

    it("returns zero for an empty window without doing I/O", async () => {
      const handle = await fixture();
      await handle.close();
      expect(await readWindow(handle, Buffer.alloc(0), Number.MAX_SAFE_INTEGER)).toBe(0);
    });

    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid position or overflowing window %s before reading",
      async (position) => {
        const handle = await fixture();
        try {
          const buffer = Buffer.alloc(2, ".");
          const read = mode === "async" ? vi.spyOn(handle, "read") : vi.spyOn(fsSync, "readSync");
          await expect(async () => await readWindow(handle, buffer, position)).rejects.toBeInstanceOf(RangeError);
          expect(read).not.toHaveBeenCalled();
          expect(buffer.toString()).toBe("..");
        } finally {
          await handle.close();
        }
      },
    );

    it("propagates read failures", async () => {
      const handle = await fixture();
      const fd = handle.fd;
      await handle.close();
      await expect(async () => mode === "async"
        ? await readFileWindowFully(handle, Buffer.alloc(1), 0)
        : readFileWindowFullySync(fd, Buffer.alloc(1), 0)).rejects.toMatchObject({ code: "EBADF" });
    });
  });
}

it("preserves a pre-aborted reason without reading", async () => {
  const handle = await fixture();
  try {
    const reason = new Error("cancelled before reading");
    const read = vi.spyOn(handle, "read");
    const buffer = Buffer.alloc(3, ".");
    await expect(readFileWindowFully(handle, buffer, 0, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(buffer.toString()).toBe("...");
  } finally {
    await handle.close();
  }
});

it("waits for an in-flight read to settle on cancellation and does not start another read", async () => {
  const handle = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("cancelled during reading");
  const original = handle.read.bind(handle);
  const read = vi.spyOn(handle, "read").mockImplementationOnce(async (buffer, offset, _length, position) => {
    const result = await original(buffer, offset, 1, position);
    entered.resolve();
    await release.promise;
    return result;
  });
  let settled = false;
  const buffer = Buffer.alloc(4, ".");
  const result = readFileWindowFully(handle, buffer, 2, { signal: controller.signal })
    .catch((error: unknown) => error)
    .finally(() => { settled = true; });
  try {
    await entered.promise;
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await result).toBe(reason);
    expect(read).toHaveBeenCalledTimes(1);
    expect(buffer.toString()).toBe("c...");
    const next = Buffer.alloc(1);
    await handle.read(next, 0, 1, null);
    expect(next.toString()).toBe("a");
  } finally {
    release.resolve();
    await result;
    await handle.close();
  }
});
