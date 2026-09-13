import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256FileSync } from "../src/durability.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const expected = {
  bytes: 6,
  digest: createHash("sha256").update("abcdef").digest("hex"),
};

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(contents: string | Buffer = "abcdef"): Promise<string> {
  const directory = await tempRoot("fs-safe-hash-sync-");
  const file = path.join(directory, "payload");
  fs.writeFileSync(file, contents);
  return file;
}

function thrownBy(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  throw new Error("Expected the synchronous operation to fail");
}

describe("synchronous SHA-256", () => {
  it.each([undefined, Infinity, 6])("hashes complete paths and borrowed descriptors with limit %s", async (maxBytes) => {
    const file = await fixture();
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, Buffer.alloc(2));
      expect(sha256FileSync(fd, { maxBytes })).toEqual(expected);
      expect(sha256FileSync(file, { maxBytes })).toEqual(expected);
      const next = Buffer.alloc(1);
      expect(fs.readSync(fd, next)).toBe(1);
      expect(next.toString()).toBe("c");
    } finally {
      fs.closeSync(fd);
    }
  });

  it.each(["auto", "off", "require"] as const)("does not load native support in %s mode", async (mode) => {
    const file = await fixture();
    configureFsSafeNative({ mode });
    const loader = vi.fn(() => { throw new Error("sync hashing must not load native support"); });
    __setNativeLoaderForTest(loader);
    const open = vi.spyOn(fs, "openSync");
    expect(sha256FileSync(file)).toEqual(expected);
    expect(() => fs.fstatSync(open.mock.results[0]!.value)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(loader).not.toHaveBeenCalled();
  });

  it("continues after positive short reads", async () => {
    const file = await fixture();
    const read = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync").mockImplementation((fd, buffer, offset, length, position) =>
      read(fd, buffer, offset, Math.min(length, 2), position));
    expect(sha256FileSync(file)).toEqual(expected);
  });

  it("accepts an empty file at zero and rejects nonempty files before reading", async () => {
    const file = await fixture("");
    expect(sha256FileSync(file, { maxBytes: 0 })).toEqual({
      bytes: 0,
      digest: createHash("sha256").digest("hex"),
    });
    fs.writeFileSync(file, "abcdef");
    const fd = fs.openSync(file, "r");
    const read = vi.spyOn(fs, "readSync");
    try {
      for (const input of [file, fd]) {
        expect(() => sha256FileSync(input, { maxBytes: 5 })).toThrow(expect.objectContaining({ code: "too-large" }));
      }
      expect(read).not.toHaveBeenCalled();
      expect(fs.fstatSync(fd).size).toBe(6);
    } finally {
      fs.closeSync(fd);
    }
  });

  it.each([-1, -Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s before I/O", (maxBytes) => {
    const open = vi.spyOn(fs, "openSync");
    const lstat = vi.spyOn(fs, "lstatSync");
    const fstat = vi.spyOn(fs, "fstatSync");
    const read = vi.spyOn(fs, "readSync");
    for (const input of ["unused-path", 123]) {
      expect(() => sha256FileSync(input, { maxBytes })).toThrow(RangeError);
    }
    for (const operation of [open, lstat, fstat, read]) expect(operation).not.toHaveBeenCalled();
  });

  it("preserves a pre-aborted reason without I/O", () => {
    const reason = { cancelled: true };
    const signal = AbortSignal.abort(reason);
    const open = vi.spyOn(fs, "openSync");
    const lstat = vi.spyOn(fs, "lstatSync");
    const fstat = vi.spyOn(fs, "fstatSync");
    const read = vi.spyOn(fs, "readSync");
    for (const input of ["unused-path", 123]) {
      expect(thrownBy(() => sha256FileSync(input, { signal }))).toBe(reason);
    }
    for (const operation of [open, lstat, fstat, read]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([0, 3, 256 * 1024])("limits consumption to %s + 1 bytes when the file grows", async (maxBytes) => {
    const file = await fixture(Buffer.alloc(maxBytes, 0x61));
    const read = fs.readSync.bind(fs);
    let bytes = 0;
    let grown = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (!grown) {
        grown = true;
        fs.appendFileSync(file, Buffer.alloc(64 * 1024, 0x62));
      }
      const count = read(...args);
      bytes += count;
      return count;
    });
    expect(() => sha256FileSync(file, { maxBytes })).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(bytes).toBe(maxBytes + 1);
  });

  it.each([
    { ownership: "path", failure: "read" },
    { ownership: "fd", failure: "read" },
    { ownership: "path", failure: "cancel" },
    { ownership: "fd", failure: "cancel" },
  ])("settles $failure failure with $ownership ownership intact", async ({ ownership, failure }) => {
    const file = await fixture();
    const borrowed = fs.openSync(file, "r");
    const controller = new AbortController();
    const reason = new Error("hash interrupted");
    const read = fs.readSync.bind(fs);
    const open = vi.spyOn(fs, "openSync");
    const close = vi.spyOn(fs, "closeSync");
    const readSpy = vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
      if (failure === "read") throw reason;
      const count = read(...args);
      controller.abort(reason);
      return count;
    });
    try {
      expect(thrownBy(() => sha256FileSync(ownership === "path" ? file : borrowed, {
        signal: controller.signal,
      }))).toBe(reason);
      expect(readSpy).toHaveBeenCalledOnce();
      if (ownership === "path") {
        const owned = open.mock.results[0]!.value;
        expect(close).toHaveBeenCalledExactlyOnceWith(owned);
        expect(() => fs.fstatSync(owned)).toThrow(expect.objectContaining({ code: "EBADF" }));
      } else {
        expect(close).not.toHaveBeenCalled();
      }
      expect(fs.fstatSync(borrowed).size).toBe(6);
      const next = Buffer.alloc(1);
      expect(read(borrowed, next, 0, 1, null)).toBe(1);
      expect(next.toString()).toBe("a");
    } finally {
      fs.closeSync(borrowed);
    }
  });

  it.each(["before-open", "after-open"])("rejects a retained pathname replacement %s before hashing", async (timing) => {
    const file = await fixture();
    const displaced = `${file}.old`;
    const open = fs.openSync.bind(fs);
    let owned = -1;
    let armed = true;
    const replace = () => {
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, "replacement");
    };
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[0] !== file || !armed) return open(...args);
      armed = false;
      if (timing === "before-open") replace();
      owned = open(...args);
      if (timing === "after-open") replace();
      return owned;
    });
    const read = vi.spyOn(fs, "readSync");
    expect(() => sha256FileSync(file)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(read).not.toHaveBeenCalled();
    expect(() => fs.fstatSync(owned)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fs.readFileSync(displaced, "utf8")).toBe("abcdef");
  });

  it("rejects exact inode differences hidden by numeric rounding", async () => {
    const file = await fixture();
    const inode = 9007199254806528n;
    expect(Number(inode)).toBe(Number(inode + 1n));
    const lstat = fs.lstatSync.bind(fs);
    const fstat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (args[0] === file) stat.ino = inode;
      return stat;
    });
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const stat = fstat(...args);
      if (args[1]?.bigint) stat.ino = inode + 1n;
      return stat;
    });
    const read = vi.spyOn(fs, "readSync");
    expect(() => sha256FileSync(file)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the shared Windows unknown-identity retry (persistent=%s)", async (persistent) => {
    const file = await fixture();
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fs.lstatSync.bind(fs);
    let observations = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (args[0] === file && (++observations === 1 || persistent)) stat.ino = 0n;
      return stat;
    });
    if (persistent) {
      expect(() => sha256FileSync(file)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(observations).toBe(2);
    } else {
      expect(sha256FileSync(file)).toEqual(expected);
    }
  });

  it("rejects a directory and preserves a missing-path I/O error", async () => {
    const directory = await tempRoot("fs-safe-hash-sync-type-");
    expect(() => sha256FileSync(directory)).toThrow(expect.objectContaining({ code: "not-file" }));
    expect(() => sha256FileSync(path.join(directory, "missing"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  itPosix("rejects a final symlink without following it", async () => {
    const file = await fixture();
    const link = `${file}.link`;
    fs.symlinkSync(file, link);
    expect(() => sha256FileSync(link)).toThrow(expect.objectContaining({ code: "symlink" }));
  });

  itPosix("rejects a FIFO substituted before open without waiting for a writer", async () => {
    const file = await fixture();
    const fifo = `${file}.fifo`;
    execFileSync("mkfifo", [fifo]);
    const open = fs.openSync.bind(fs);
    let owned = -1;
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      expect(Number(args[1]) & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
      fs.renameSync(file, `${file}.old`);
      fs.renameSync(fifo, file);
      owned = open(...args);
      return owned;
    });
    expect(() => sha256FileSync(file)).toThrow(expect.objectContaining({ code: "not-file" }));
    expect(() => fs.fstatSync(owned)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
});
