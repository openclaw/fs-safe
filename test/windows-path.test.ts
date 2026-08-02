import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileStore } from "../src/file-store.js";
import { isWindowsNetworkPath } from "../src/local-file-access.js";
import {
  isPathInside,
  normalizeWindowsPathForComparison,
  splitSafeRelativePath,
} from "../src/path.js";

describe("Windows path classification", () => {
  it("distinguishes extended local paths from UNC paths", () => {
    expect(isWindowsNetworkPath("\\\\server\\share\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\UNC\\server\\share\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\C:\\secrets\\token", "win32")).toBe(false);
    expect(
      isWindowsNetworkPath("\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\token", "win32"),
    ).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\Volume{abc}\\secrets\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\.\\pipe\\service", "win32")).toBe(true);
  });
});

describe("Windows comparison normalization", () => {
  it("keeps surrounding whitespace so padded paths stay distinct", () => {
    expect(normalizeWindowsPathForComparison("C:\\root ")).toBe("c:\\root ");
    expect(normalizeWindowsPathForComparison("C:\\root\u00a0")).toBe(
      "c:\\root\u00a0",
    );
  });

  it("still lowercases, normalizes separators, and strips the extended-length prefix", () => {
    expect(normalizeWindowsPathForComparison("\\\\?\\UNC\\Server\\Share\\A/../B")).toContain(
      "\\\\server\\share",
    );
    expect(normalizeWindowsPathForComparison("\\\\?\\C:\\Users/Public")).toBe(
      "c:\\users\\public",
    );
  });
});

describe("drive-relative relative paths", () => {
  it("rejects drive-letter segments that Windows would resolve away", () => {
    const inputs = ["C:evil", "c:evil", "C:", "C:..", "C:evil/sub", "a/C:b", "./C:evil", "a/D:b"];
    for (const input of inputs) {
      expect(() => splitSafeRelativePath(input)).toThrow("drive letter");
    }
  });

  it("keeps accepting ordinary segments that merely contain a colon", () => {
    expect(splitSafeRelativePath("logs/2026-08-02T10:30:00Z.log")).toEqual([
      "logs",
      "2026-08-02T10:30:00Z.log",
    ]);
  });

  it("stops a drive-relative store key from aliasing a plain key", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-drive-relative-"));
    try {
      const store = fileStore({ rootDir });
      await store.writeText("secret.txt", "real");

      await expect(store.writeText("C:secret.txt", "aliased")).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(readFile(path.join(rootDir, "secret.txt"), "utf8")).resolves.toBe("real");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")("Windows containment with padded roots", () => {
  it("does not report a sibling directory as inside a space-padded root", () => {
    expect(isPathInside("C:\\root ", "C:\\root\\secret.txt")).toBe(false);
  });

  it("still reports genuine descendants as inside", () => {
    expect(isPathInside("C:\\root", "C:\\root\\secret.txt")).toBe(true);
  });
});
