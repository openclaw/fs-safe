import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyRootFileSync, sameFileContentsSync } from "../src/advanced.js";
import { sha256File, sha256FileSync } from "../src/durability.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const native = loadTestNative("required-env");
const locked = { offset: 40, length: 8 };
const content = Buffer.alloc(100).map((_, index) => index + 1);
const zeroed = Buffer.from(content).fill(0, locked.offset, locked.offset + locked.length);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

/** Windows refuses reads of a byte range another handle locks exclusively. */
function lockRange(fds: () => readonly number[]) {
  const readSync = fs.readSync;
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number,
    length: number, position: number | null) => {
    if (fds().includes(fd) && typeof position === "number" && position < locked.offset + locked.length &&
      position + length > locked.offset) {
      throw Object.assign(new Error("EBUSY: resource busy or locked, read"), { code: "EBUSY", syscall: "read" });
    }
    return readSync(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
}

async function file(name: string, bytes: Buffer = content) {
  const target = path.join(await tempRoot("fs-safe-zero-ranges-"), name);
  fs.writeFileSync(target, bytes);
  return target;
}

describe("zero ranges", () => {
  it("hashes ranges as zeros without reading them", async () => {
    const source = await file("source");
    const fd = fs.openSync(source, "r");
    try {
      lockRange(() => [fd]);
      expect(() => sha256FileSync(fd)).toThrow(expect.objectContaining({ code: "EBUSY" }));
      expect(sha256FileSync(fd, { zeroRanges: [locked] })).toEqual({ bytes: 100, digest: digest(zeroed) });
    } finally {
      fs.closeSync(fd);
    }
  });

  it("hashes asynchronously without native hashing, and stops zeros at EOF", async () => {
    // Native hashing reads every byte; with a binding present it must stay unused.
    const sha256 = vi.fn(() => { throw new Error("native hashing reads every byte"); });
    if (native) __setNativeLoaderForTest(() => ({ ...native, sha256File: sha256 }));
    configureFsSafeNative({ mode: native ? "require" : "off" });
    expect(await sha256File(await file("source"), { zeroRanges: [locked] }))
      .toEqual({ bytes: 100, digest: digest(zeroed) });
    const short = content.subarray(0, locked.offset + 3);
    expect(await sha256File(await file("short", short), { zeroRanges: [locked] }))
      .toEqual({ bytes: short.length, digest: digest(zeroed.subarray(0, short.length)) });
    expect(sha256).not.toHaveBeenCalled();
  });

  it("compares ranges as zeros but still requires equal extents", async () => {
    const altered = Buffer.from(content).fill(0xff, locked.offset, locked.offset + locked.length);
    const fds = [fs.openSync(await file("left"), "r"), fs.openSync(await file("right", altered), "r")] as const;
    const short = fs.openSync(await file("short", content.subarray(0, locked.offset + 3)), "r");
    try {
      lockRange(() => [...fds, short]);
      expect(sameFileContentsSync(...fds, { zeroRanges: [locked] })).toBe(true);
      expect(sameFileContentsSync(fds[0], short, { zeroRanges: [locked] })).toBe(false);
      expect(() => sameFileContentsSync(...fds)).toThrow(expect.objectContaining({ code: "EBUSY" }));
    } finally {
      for (const fd of [...fds, short]) fs.closeSync(fd);
    }
  });

  it("copies ranges as zeros without reading them", async () => {
    configureFsSafeNative({ mode: "off" });
    const source = await file("source");
    const targetRoot = path.join(path.dirname(source), "target");
    fs.mkdirSync(targetRoot);
    const opened = vi.spyOn(fs, "openSync");
    lockRange(() => opened.mock.results.flatMap((result) => result.type === "return" ? [result.value] : []));
    using copied = copyRootFileSync({
      source: { rootPath: path.dirname(source), absolutePath: source },
      destination: { rootPath: targetRoot, absolutePath: path.join(targetRoot, "copy") },
      zeroRanges: [locked],
    });
    vi.restoreAllMocks();
    expect(fs.readFileSync(copied.path)).toEqual(zeroed);
  });

  it.each([
    [{ offset: -1, length: 1 }],
    [{ offset: 0, length: 0 }],
    [{ offset: 1.5, length: 1 }],
    [{ offset: Number.MAX_SAFE_INTEGER, length: 1 }],
  ])("rejects invalid range %o before reading", async (range) => {
    const source = await file("source");
    const open = vi.spyOn(fs, "openSync");
    expect(() => sha256FileSync(source, { zeroRanges: [range] })).toThrow(RangeError);
    expect(open).not.toHaveBeenCalled();
  });
});
