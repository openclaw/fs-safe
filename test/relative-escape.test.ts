import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { isPathRelativeEscape } from "../src/path.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("isPathRelativeEscape", () => {
  it.each(["../secret", "foo/../../x", "./../secret", "..", "../inside/../x"])(
    "rejects an escaping path: %s", (input) => expect(isPathRelativeEscape(input)).toBe(true),
  );

  it.each(["foo/bar", "", ".", "foo/../bar", "foo/..", "foo//./../bar", "..safe/name"])(
    "accepts a contained relative path: %s", (input) => expect(isPathRelativeEscape(input)).toBe(false),
  );

  it("uses native absolute and backslash semantics", () => {
    expect(isPathRelativeEscape("..\\secret")).toBe(process.platform === "win32");
    expect(isPathRelativeEscape("foo\\..\\secret")).toBe(false);
    expect(isPathRelativeEscape("/secret")).toBe(true);
    expect(isPathRelativeEscape("C:\\secret")).toBe(process.platform === "win32");
    expect(isPathRelativeEscape("C:/secret")).toBe(process.platform === "win32");
  });

  it("recognizes both Windows separators with native Windows path operations", () => {
    if (process.platform !== "win32") {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.spyOn(path, "isAbsolute").mockImplementation(path.win32.isAbsolute);
      vi.spyOn(path, "sep", "get").mockReturnValue("\\");
    }
    for (const input of ["../secret", "..\\secret", "foo/..\\../secret", "C:/secret"]) {
      expect(isPathRelativeEscape(input), input).toBe(true);
    }
    expect(isPathRelativeEscape("foo/..\\bar")).toBe(false);
  });

  itPosix("writes and reads a literal backslash filename inside a Root", async () => {
    const dir = await tempRoot("fs-safe-relative-escape-");
    const bounded = await root(dir);
    await bounded.write("..\\secret", "literal");
    expect(await bounded.readText("..\\secret")).toBe("literal");
    expect(await fs.readFile(path.join(dir, "..\\secret"), "utf8")).toBe("literal");
  });
});
