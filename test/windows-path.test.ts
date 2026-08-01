import { describe, expect, it } from "vitest";
import { isWindowsNetworkPath } from "../src/local-file-access.js";
import { isPathInside, normalizeWindowsPathForComparison } from "../src/path.js";

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

describe.skipIf(process.platform !== "win32")("Windows containment with padded roots", () => {
  it("does not report a sibling directory as inside a space-padded root", () => {
    expect(isPathInside("C:\\root ", "C:\\root\\secret.txt")).toBe(false);
  });

  it("still reports genuine descendants as inside", () => {
    expect(isPathInside("C:\\root", "C:\\root\\secret.txt")).toBe(true);
  });
});
