import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRootFile, openRootFileSync } from "../src/advanced.js";
import { FsSafeError } from "../src/errors.js";
import { readSecretFileSync, tryReadSecretFileSync } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function captureThrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected admission to throw");
}

const closeFailures = [
  { name: "an Error", failure: new Error("close failed") },
  { name: "undefined", failure: undefined },
];

describe.each([
  { name: "strict", read: readSecretFileSync },
  { name: "optional", read: tryReadSecretFileSync },
])("$name secret reader admission cleanup", ({ read }) => {
  it.each(closeFailures)("preserves a pin mismatch when close throws $name", async ({ failure }) => {
    const root = await tempRoot("fs-safe-secret-pin-close-");
    const filePath = path.join(root, "token");
    const displacedPath = path.join(root, "original");
    const replacementPath = path.join(root, "replacement");
    await fs.writeFile(filePath, "original");
    await fs.writeFile(replacementPath, "replacement");
    const lstat = fsSync.lstatSync.bind(fsSync);
    let pathInspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (args[0] === filePath && args[1]?.bigint && ++pathInspections === 2) {
        // The pin's second bigint lstat occurs after descriptor acquisition.
        fsSync.renameSync(filePath, displacedPath);
        fsSync.renameSync(replacementPath, filePath);
      }
      return lstat(...args);
    });
    const bytes = vi.spyOn(fsSync, "readSync");
    const realClose = fsSync.closeSync.bind(fsSync);
    const close = vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      realClose(fd);
      throw failure;
    });

    const error = captureThrown(() => read(filePath, "token"));

    expect(error).toBeInstanceOf(FsSafeError);
    expect(error).toMatchObject({
      code: "path-mismatch",
      category: "policy",
      cause: expect.objectContaining({ message: "security validation failed" }),
    });
    expect(pathInspections).toBe(2);
    expect(bytes).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => fsSync.fstatSync(close.mock.calls[0]![0])).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("original");
  });
});

describe.each([
  { name: "sync", open: openRootFileSync },
  { name: "async", open: openRootFile },
])("$name root file admission cleanup", ({ open }) => {
  it.each(closeFailures)("preserves an I/O result when close throws $name", async ({ failure }) => {
    const root = await tempRoot("fs-safe-root-pin-close-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "contents");
    const primary = Object.assign(new Error("descriptor inspection failed"), { code: "EIO" });
    const openSync = vi.fn(fsSync.openSync);
    const fstatSync = vi.fn(() => { throw primary; });
    const readFileSync = vi.fn(fsSync.readFileSync);
    const closeSync = vi.fn((fd: number) => {
      fsSync.closeSync(fd);
      throw failure;
    });

    const opened = await open({
      absolutePath: filePath,
      rootPath: root,
      boundaryLabel: "test root",
      ioFs: {
        ...fsSync, openSync, fstatSync, closeSync,
        readFileSync: readFileSync as typeof fsSync.readFileSync,
      },
    });

    expect(opened).toStrictEqual({ ok: false, reason: "io", error: primary });
    if (opened.ok) throw new Error("Expected descriptor admission to fail");
    expect(opened.error).toBe(primary);
    expect(opened).not.toHaveProperty("fd");
    expect(openSync).toHaveBeenCalledTimes(1);
    const fd = openSync.mock.results[0]!.value as number;
    expect(fstatSync).toHaveBeenCalledExactlyOnceWith(fd);
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(fd);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("transfers a successful open descriptor to the caller without closing it", async () => {
    const root = await tempRoot("fs-safe-root-pin-owner-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "contents");
    const openSync = vi.fn(fsSync.openSync);
    const closeSync = vi.fn(fsSync.closeSync);

    const opened = await open({
      absolutePath: filePath,
      rootPath: root,
      boundaryLabel: "test root",
      ioFs: { ...fsSync, openSync, closeSync },
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("Expected descriptor ownership transfer");
    try {
      expect(openSync).toHaveBeenCalledTimes(1);
      expect(opened.fd).toBe(openSync.mock.results[0]!.value);
      expect(closeSync).not.toHaveBeenCalled();
      expect(fsSync.fstatSync(opened.fd).isFile()).toBe(true);
      expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("contents");
      expect(closeSync).not.toHaveBeenCalled();
    } finally {
      closeSync(opened.fd);
    }
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(opened.fd);
    expect(() => fsSync.fstatSync(opened.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
});
