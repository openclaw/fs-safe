import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSafeRelativePath } from "../src/path.js";
import { resolvePathPreservingWindowsRoot } from "../src/windows-path-alias.js";

const roots = process.platform === "win32"
  ? ["C:\\root", "\\\\server\\share\\root", "\\\\?\\C:\\", "\\\\?\\UNC\\server\\share\\root"]
  : ["/root", "/", "relative-root"];

describe("deep lexical relative paths", () => {
  it.each(roots)("resolves all components without argument spreading under %s", root => {
    const relative = `${"a/".repeat(150_000)}last`;
    expect(resolveSafeRelativePath(root, relative)).toBe(path.resolve(root, relative));
    expect(() => resolveSafeRelativePath(root, `${relative}/../outside`))
      .toThrow(expect.objectContaining({ code: "invalid-path" }));
  });

  it.each(roots)("retains empty and normalized shallow suffix behavior under %s", root => {
    for (const relative of ["", ".", "./", "one//./two", "one/with space/é/last"]) {
      expect(resolveSafeRelativePath(root, relative)).toBe(
        relative === "" || relative === "." || relative === "./"
          ? resolvePathPreservingWindowsRoot(root)
          : path.resolve(root, relative),
      );
    }
  });

  it.skipIf(process.platform === "win32")("retains admitted POSIX colon names", () => {
    expect(resolveSafeRelativePath("/root", "logs/10:30/file")).toBe("/root/logs/10:30/file");
  });
});
