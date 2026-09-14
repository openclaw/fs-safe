import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overwriteFileHandle } from "../src/advanced.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const handles: FileHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map(handle => handle.close()));
});

async function fixture(original = "original", flags: string | number = "r+") {
  const directory = await tempRoot("fs-safe-overwrite-");
  const file = path.join(directory, "payload");
  await fs.writeFile(file, original, { mode: 0o640 });
  const handle = await fs.open(file, flags);
  handles.push(handle);
  return { directory, file, handle, original };
}

describe("borrowed FileHandle overwrite", () => {
  it.each(["longer replacement", "samebyte", "short", "", "héllo crab 🦀"])(
    "writes the exact supplied byte view %j and preserves the caller cursor",
    async (replacement) => {
      const f = await fixture();
      const bytes = Buffer.from(replacement);
      const backing = Buffer.concat([Buffer.from("before"), bytes, Buffer.from("after")]);
      const data = new Uint8Array(backing.buffer, backing.byteOffset + 6, bytes.length);
      await f.handle.read(Buffer.alloc(2), 0, 2, null);
      const initial = await f.handle.stat();
      await overwriteFileHandle(f.handle, data);
      expect(await fs.readFile(f.file)).toEqual(bytes);
      const after = await f.handle.stat();
      expect({ dev: after.dev, ino: after.ino, mode: after.mode, uid: after.uid, gid: after.gid })
        .toEqual({ dev: initial.dev, ino: initial.ino, mode: initial.mode, uid: initial.uid, gid: initial.gid });
      // Appending after an empty/shrunk overwrite lets us observe the retained offset too.
      if (bytes.length < 3) await fs.appendFile(f.file, "abcdef");
      const current = await fs.readFile(f.file);
      const next = Buffer.alloc(1);
      expect((await f.handle.read(next, 0, 1, null)).bytesRead).toBe(1);
      expect(next).toEqual(current.subarray(2, 3));
    },
  );

  it("completes positive short prefix reads and writes", async () => {
    const f = await fixture("original content");
    const read = f.handle.read.bind(f.handle);
    const write = f.handle.write.bind(f.handle);
    vi.spyOn(f.handle, "read").mockImplementation(async (buffer, offset, length, position) =>
      await read(buffer, offset, Math.min(length, 3), position));
    vi.spyOn(f.handle, "write").mockImplementation(async (buffer, offset, length, position) =>
      await write(buffer, offset, Math.min(length, 2), position));
    await overwriteFileHandle(f.handle, Buffer.from("replacement with a longer tail"));
    expect(await fs.readFile(f.file, "utf8")).toBe("replacement with a longer tail");
  });

  it("fills an empty file without reading a rollback prefix", async () => {
    const f = await fixture("");
    const read = vi.spyOn(f.handle, "read");
    await overwriteFileHandle(f.handle, Buffer.from("new"));
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe("new");
  });

  it("rejects an unrepresentable original size before preparation or mutation", async () => {
    const f = await fixture();
    const stat = await f.handle.stat();
    vi.spyOn(f.handle, "stat").mockResolvedValue(Object.assign(stat, { size: Number.MAX_SAFE_INTEGER + 1 }));
    const read = vi.spyOn(f.handle, "read");
    const write = vi.spyOn(f.handle, "write");
    const truncate = vi.spyOn(f.handle, "truncate");
    const beforeWrite = vi.fn();
    await expect(overwriteFileHandle(f.handle, Buffer.from("new"), { beforeWrite }))
      .rejects.toBeInstanceOf(RangeError);
    for (const operation of [read, write, truncate, beforeWrite]) expect(operation).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
  });

  it("reads only the overwritten prefix and admits the write once after preparation", async () => {
    const f = await fixture("original with a retained tail");
    const read = f.handle.read.bind(f.handle);
    let captured = 0;
    vi.spyOn(f.handle, "read").mockImplementation(async (...args) => {
      const result = await read(...args);
      captured += result.bytesRead;
      return result;
    });
    const beforeWrite = vi.fn(() => {
      expect(captured).toBe(3);
      expect(fsSync.readFileSync(f.file, "utf8")).toBe(f.original);
    });
    await overwriteFileHandle(f.handle, Buffer.from("new"), { beforeWrite });
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(await fs.readFile(f.file, "utf8")).toBe("new");
  });

  it("refuses revoked authority after a pending prefix read without mutating", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.handle.read.bind(f.handle);
    let active = true;
    const reason = new Error("write owner retired");
    vi.spyOn(f.handle, "read").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const write = vi.spyOn(f.handle, "write");
    const truncate = vi.spyOn(f.handle, "truncate");
    const pending = overwriteFileHandle(f.handle, Buffer.from("replacement"), {
      beforeWrite() { if (!active) throw reason; },
    }).catch((error: unknown) => error);
    try {
      await entered.promise;
      active = false;
    } finally {
      release.resolve();
    }
    expect(await pending).toBe(reason);
    expect(write).not.toHaveBeenCalled();
    expect(truncate).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
  });

  it("rejects an asynchronous beforeWrite callback before mutation", async () => {
    const f = await fixture();
    const write = vi.spyOn(f.handle, "write");
    const truncate = vi.spyOn(f.handle, "truncate");
    await expect(overwriteFileHandle(f.handle, Buffer.from("new"), {
      beforeWrite: async () => { throw new Error("late refusal"); },
    })).rejects.toThrow("beforeWrite must be synchronous");
    expect(write).not.toHaveBeenCalled();
    expect(truncate).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
  });

  it("settles an admitted write without entering beforeWrite again", async () => {
    const f = await fixture();
    const write = f.handle.write.bind(f.handle);
    let active = true;
    const beforeWrite = vi.fn(() => { if (!active) throw new Error("retired after admission"); });
    vi.spyOn(f.handle, "write").mockImplementation(async (...args) => {
      const result = await write(...args);
      active = false;
      return result;
    });
    await overwriteFileHandle(f.handle, Buffer.from("replacement with a longer tail"), { beforeWrite });
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(await fs.readFile(f.file, "utf8")).toBe("replacement with a longer tail");
  });

  it.each(["tail", "prefix", "shrink"])("restores original bytes and size after a %s failure", async (phase) => {
    const f = await fixture();
    const payload = Buffer.from(phase === "shrink" ? "new" : "replacement with a longer tail");
    const originalSize = Buffer.byteLength(f.original);
    const reason = Object.assign(new Error("synthetic I/O failure"), { code: "ENOSPC" });
    const write = f.handle.write.bind(f.handle);
    const truncate = f.handle.truncate.bind(f.handle);
    let failed = false;
    vi.spyOn(f.handle, "write").mockImplementation(async (buffer, offset, length, position) => {
      if (!failed && ((phase === "tail" && position === originalSize) || (phase === "prefix" && position === 0))) {
        failed = true;
        await write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        throw reason;
      }
      return await write(buffer, offset, length, position);
    });
    vi.spyOn(f.handle, "truncate").mockImplementation(async (length) => {
      if (!failed && phase === "shrink" && length! < originalSize) {
        failed = true;
        throw reason;
      }
      await truncate(length);
    });
    await f.handle.read(Buffer.alloc(2), 0, 2, null);
    await expect(overwriteFileHandle(f.handle, payload)).rejects.toBe(reason);
    expect(failed).toBe(true);
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
    expect((await f.handle.stat()).size).toBe(originalSize);
    const next = Buffer.alloc(1);
    await f.handle.read(next, 0, 1, null);
    expect(next.toString()).toBe(f.original[2]);
  });

  it("attempts both recovery steps and retains the original error if recovery also fails", async () => {
    const f = await fixture();
    const reason = new Error("original write failure");
    const write = f.handle.write.bind(f.handle);
    let failed = false;
    const recovery: string[] = [];
    vi.spyOn(f.handle, "write").mockImplementation(async (buffer, offset, length, position) => {
      if (failed) {
        recovery.push("prefix");
        throw new Error("prefix recovery failed");
      }
      await write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
      failed = true;
      throw reason;
    });
    vi.spyOn(f.handle, "truncate").mockImplementation(async () => {
      recovery.push("truncate");
      throw new Error("length recovery failed");
    });
    await expect(overwriteFileHandle(f.handle, Buffer.from("short"))).rejects.toBe(reason);
    expect(recovery).toEqual(["prefix", "truncate"]);
    expect((await f.handle.stat()).isFile()).toBe(true);
  });

  it("waits for rollback to finish before reporting the write failure", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reason = new Error("partial overwrite");
    const write = f.handle.write.bind(f.handle);
    let failed = false;
    vi.spyOn(f.handle, "write").mockImplementation(async (buffer, offset, length, position) => {
      if (!failed) {
        failed = true;
        await write(buffer, offset, 1, position);
        throw reason;
      }
      entered.resolve();
      await release.promise;
      return await write(buffer, offset, length, position);
    });
    let settled = false;
    const pending = overwriteFileHandle(f.handle, Buffer.from("short"))
      .catch((error: unknown) => error)
      .finally(() => { settled = true; });
    try {
      await entered.promise;
      expect(settled).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await pending).toBe(reason);
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
  });

  it("rejects incomplete prefix capture before admission or writes", async () => {
    const f = await fixture();
    const read = f.handle.read.bind(f.handle);
    const truncate = f.handle.truncate.bind(f.handle);
    vi.spyOn(f.handle, "read").mockImplementationOnce(async (...args) => {
      await truncate(1);
      return await read(...args);
    });
    const write = vi.spyOn(f.handle, "write");
    const restore = vi.spyOn(f.handle, "truncate");
    const beforeWrite = vi.fn();
    await expect(overwriteFileHandle(f.handle, Buffer.from("replacement"), { beforeWrite }))
      .rejects.toMatchObject({ code: "read-failed" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original[0]);
  });

  it("rejects a zero-progress write and restores the original", async () => {
    const f = await fixture();
    vi.spyOn(f.handle, "write").mockImplementationOnce(async (buffer) => ({ buffer, bytesWritten: 0 }));
    await expect(overwriteFileHandle(f.handle, Buffer.from("short")))
      .rejects.toMatchObject({ code: "helper-failed" });
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
  });

  it.each([fsSync.constants.O_RDONLY, fsSync.constants.O_WRONLY])("does not replace or close a handle with access flags %s", async (flags) => {
    const f = await fixture("original", flags);
    await expect(overwriteFileHandle(f.handle, Buffer.from("short"))).rejects.toBeDefined();
    expect(await fs.readFile(f.file, "utf8")).toBe(f.original);
    expect((await f.handle.stat()).size).toBe(Buffer.byteLength(f.original));
  });

  itPosix.each(["symlink", "hardlink"])("preserves an opened %s and updates the same inode", async (kind) => {
    const f = await fixture();
    const alias = path.join(f.directory, "alias");
    await (kind === "symlink" ? fs.symlink : fs.link)(f.file, alias);
    const handle = await fs.open(alias, "r+");
    handles.push(handle);
    const original = await handle.stat();
    await overwriteFileHandle(handle, Buffer.from("replacement"));
    expect((await handle.stat()).ino).toBe(original.ino);
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(kind === "symlink");
    expect(await fs.readFile(alias, "utf8")).toBe("replacement");
    expect(await fs.readFile(f.file, "utf8")).toBe("replacement");
  });

  itPosix("rejects a borrowed directory before preparation", async () => {
    const directory = await tempRoot("fs-safe-overwrite-directory-");
    const handle = await fs.open(directory, "r");
    handles.push(handle);
    const beforeWrite = vi.fn();
    await expect(overwriteFileHandle(handle, Buffer.from("new"), { beforeWrite }))
      .rejects.toMatchObject({ code: "not-file" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect((await handle.stat()).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("writes inside a read-only parent without changing its permissions", async () => {
    const f = await fixture();
    await fs.chmod(f.file, 0o640);
    await fs.chmod(f.directory, 0o500);
    try {
      await overwriteFileHandle(f.handle, Buffer.from("replacement"));
      expect(await fs.readFile(f.file, "utf8")).toBe("replacement");
      expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o500);
      expect((await f.handle.stat()).mode & 0o777).toBe(0o640);
    } finally {
      await fs.chmod(f.directory, 0o700);
    }
  });
});
