import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sameFileContentsSync } from "../src/advanced.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const descriptors: number[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const fd of descriptors.splice(0)) fs.closeSync(fd);
});

async function fixture(left: string | Buffer = "abcdef", right: string | Buffer = left) {
  const directory = await tempRoot("fs-safe-contents-");
  const paths = [path.join(directory, "left"), path.join(directory, "right")] as const;
  fs.writeFileSync(paths[0], left);
  fs.writeFileSync(paths[1], right);
  const fds = [fs.openSync(paths[0], "r"), fs.openSync(paths[1], "r")] as const;
  descriptors.push(...fds);
  return { directory, paths, fds };
}

function thrownBy(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  throw new Error("Expected comparison to fail");
}

describe("borrowed descriptor content comparison", () => {
  it.each([0, 1, 1024 * 1024, 2 * 1024 * 1024 + 37])("compares every byte of equal %i-byte files", async size => {
    const content = Buffer.alloc(size).map((_, index) => index % 251);
    const { fds } = await fixture(content);
    expect(sameFileContentsSync(...fds)).toBe(true);
  });

  it.each([0, 1024 * 1024, 2 * 1024 * 1024 + 36])("detects a differing byte at offset %i", async offset => {
    const left = Buffer.alloc(2 * 1024 * 1024 + 37, 0x61);
    const right = Buffer.from(left);
    right[offset] = 0x62;
    const { fds } = await fixture(left, right);
    expect(sameFileContentsSync(...fds)).toBe(false);
  });

  it.each([
    ["", "a"], ["a", ""], ["abc", "abcd"], ["abcd", "abc"],
  ])("rejects unequal lengths for %j and %j", async (left, right) => {
    const { fds } = await fixture(left, right);
    expect(sameFileContentsSync(...fds)).toBe(false);
  });

  it.each([false, true])("starts at zero and preserves both cursors and lifetimes (different=%s)", async different => {
    const { fds, paths } = await fixture("abcdef", different ? "xbcdef" : "abcdef");
    fs.readSync(fds[0], Buffer.alloc(2));
    fs.readSync(fds[1], Buffer.alloc(4));
    expect(sameFileContentsSync(...fds)).toBe(!different);
    expect(sameFileContentsSync(fds[0], fds[0])).toBe(true);
    for (const [index, expected] of ["c", "e"].entries()) {
      const next = Buffer.alloc(1);
      expect(fs.readSync(fds[index]!, next)).toBe(1);
      expect(next.toString()).toBe(expected);
      expect(fs.fstatSync(fds[index]!).size).toBe(6);
    }
    expect(fs.readFileSync(paths[0], "utf8")).toBe("abcdef");
    expect(fs.readFileSync(paths[1], "utf8")).toBe(different ? "xbcdef" : "abcdef");
  });

  it.each([false, true])("aligns independent positive short reads (different=%s)", async different => {
    const left = Buffer.alloc(317).map((_, index) => index % 251);
    const right = Buffer.from(left);
    if (different) right[316] = right[316]! ^ 1;
    const { fds } = await fixture(left, right);
    const read = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync").mockImplementation((fd, buffer, offset, length, position) =>
      read(fd, buffer, offset, Math.min(length, fd === fds[0] ? 7 : 19), position));
    expect(sameFileContentsSync(...fds)).toBe(!different);
  });

  it.each([
    { left: "abcdef", right: "abcdef", sizes: [0, 42], equal: true },
    { left: "abc", right: "abcdef", sizes: [6, 6], equal: false },
    { left: "abcdef", right: "abc", sizes: [6, 6], equal: false },
    { left: "abcdef", right: "abcxef", sizes: [0, 0], equal: false },
  ])("uses actual bytes and EOF when sizes report $sizes", async ({ left, right, sizes, equal }) => {
    const { fds } = await fixture(left, right);
    const stat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const observed = stat(...args);
      const size = sizes[args[0] === fds[0] ? 0 : 1]!;
      return Object.assign(observed, { size: typeof observed.size === "bigint" ? BigInt(size) : size });
    });
    expect(sameFileContentsSync(...fds)).toBe(equal);
  });

  it.each(["shrink", "grow"] as const)("reads to actual EOF after files %s following admission", async change => {
    const { fds, paths } = await fixture("abcdef", "abcdefghij");
    const read = fs.readSync.bind(fs);
    let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (!changed) {
        changed = true;
        if (change === "shrink") {
          for (const file of paths) fs.truncateSync(file, 3);
        } else {
          fs.appendFileSync(paths[0], "ghij");
        }
      }
      return read(...args);
    });
    expect(sameFileContentsSync(...fds)).toBe(true);
    expect(changed).toBe(true);
  });

  it.each([0, 3, Number.MAX_SAFE_INTEGER, Infinity])("accepts a complete comparison within limit %s", async maxBytes => {
    const { fds } = await fixture(maxBytes === 0 ? "" : "abc");
    expect(sameFileContentsSync(...fds, { maxBytes })).toBe(true);
  });

  it("does not inherit the Root default byte limit", async () => {
    const { fds, paths } = await fixture("");
    for (const file of paths) fs.truncateSync(file, 17 * 1024 * 1024);
    expect(sameFileContentsSync(...fds)).toBe(true);
  });

  it.each([-1, -Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid maxBytes %s before I/O", maxBytes => {
    const stat = vi.spyOn(fs, "fstatSync");
    const read = vi.spyOn(fs, "readSync");
    expect(() => sameFileContentsSync(-1, -1, { maxBytes })).toThrow(RangeError);
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["left", "right", "same"] as const)("rejects initially oversized %s input before reading", async side => {
    const { fds } = await fixture(side === "right" ? "" : "abcd", side === "left" ? "" : "abcd");
    const read = vi.spyOn(fs, "readSync");
    expect(() => sameFileContentsSync(fds[0], side === "same" ? fds[0] : fds[1], { maxBytes: 3 }))
      .toThrow(expect.objectContaining({ code: "too-large" }));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, 1])("rejects unsafe reported size on input %i even without a configured cap", async side => {
    const { fds } = await fixture();
    const stat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const observed = stat(...args);
      if (args[0] === fds[side]) {
        return Object.assign(observed, { size: typeof observed.size === "bigint"
          ? BigInt(Number.MAX_SAFE_INTEGER) + 1n : Number.MAX_SAFE_INTEGER + 1 });
      }
      return observed;
    });
    const read = vi.spyOn(fs, "readSync");
    expect(() => sameFileContentsSync(...fds)).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(read).not.toHaveBeenCalled();
  });

  describe.each([0, 1])("growth of input %i", side => {
    it.each([0, 3, 1024 * 1024 + 7])("rejects growth after consuming at most %i + 1 bytes per input", async maxBytes => {
      const { fds, paths } = await fixture(Buffer.alloc(maxBytes, 0x61));
      const read = fs.readSync.bind(fs);
      const consumed = [0, 0];
      let grown = false;
      vi.spyOn(fs, "readSync").mockImplementation((...args) => {
        if (!grown) {
          grown = true;
          fs.appendFileSync(paths[side]!, Buffer.alloc(4096, 0x62));
        }
        const count = read(...args);
        consumed[args[0] === fds[0] ? 0 : 1]! += count;
        return count;
      });
      expect(() => sameFileContentsSync(...fds, { maxBytes }))
        .toThrow(expect.objectContaining({ code: "too-large" }));
      expect(consumed[side]).toBe(maxBytes + 1);
      for (const bytes of consumed) expect(bytes).toBeLessThanOrEqual(maxBytes + 1);
    });
  });

  describe.each(["stat", "read"] as const)("%s failure", operation => {
    it.each(["left", "right", "same"] as const)("preserves the %s error and borrowed handles", async side => {
      const { fds } = await fixture();
      const read = fs.readSync.bind(fs);
      const stat = fs.fstatSync.bind(fs);
      for (const fd of fds) read(fd, Buffer.alloc(2), 0, 2, null);
      const failing = fds[side === "right" ? 1 : 0];
      const failure = Object.assign(new Error("synthetic file I/O failure"), { code: "EIO" });
      if (operation === "stat") {
        vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
          if (args[0] === failing) throw failure;
          return stat(...args);
        });
      } else {
        vi.spyOn(fs, "readSync").mockImplementation((...args) => {
          if (args[0] === failing) throw failure;
          return read(...args);
        });
      }
      expect(thrownBy(() => sameFileContentsSync(fds[0], side === "same" ? fds[0] : fds[1]))).toBe(failure);
      for (const fd of fds) {
        expect(stat(fd).isFile()).toBe(true);
        const next = Buffer.alloc(1);
        expect(read(fd, next, 0, 1, null)).toBe(1);
        expect(next.toString()).toBe("c");
      }
    });
  });

  it.each([undefined, 3])("requires a successful EOF probe before equality (maxBytes=%s)", async maxBytes => {
    const { fds } = await fixture("abc");
    const read = fs.readSync.bind(fs);
    const failure = new Error("synthetic EOF probe failure");
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (args[0] === fds[1] && args[4] === 3) throw failure;
      return read(...args);
    });
    expect(thrownBy(() => sameFileContentsSync(...fds, { maxBytes }))).toBe(failure);
    for (const fd of fds) expect(fs.fstatSync(fd).isFile()).toBe(true);
  });

  it.each([0, 1])("rejects nonregular input %i before reading on every platform", async side => {
    const { directory, fds } = await fixture();
    const directoryStat = fs.statSync(directory, { bigint: true });
    const stat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) =>
      args[0] === fds[side] ? directoryStat : stat(...args));
    const read = vi.spyOn(fs, "readSync");
    expect(() => sameFileContentsSync(...fds)).toThrow(expect.objectContaining({ code: "not-file" }));
    expect(read).not.toHaveBeenCalled();
  });

  itPosix("rejects a real directory descriptor, including comparison with itself", async () => {
    const { directory, fds } = await fixture();
    const directoryFd = fs.openSync(directory, "r");
    descriptors.push(directoryFd);
    for (const left of [fds[0], directoryFd]) {
      expect(() => sameFileContentsSync(left, directoryFd)).toThrow(expect.objectContaining({ code: "not-file" }));
    }
  });

  it("does not accept a closed descriptor as equal to itself", async () => {
    const { fds } = await fixture();
    fs.closeSync(fds[0]);
    descriptors.splice(descriptors.indexOf(fds[0]), 1);
    expect(() => sameFileContentsSync(fds[0], fds[0])).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fs.fstatSync(fds[1]).isFile()).toBe(true);
  });
});
