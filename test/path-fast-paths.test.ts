import path from "node:path";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isPathInside } from "../src/path.js";
import { safePathSegmentHashed } from "../src/install-path.js";
import { sanitizeUntrustedFileName } from "../src/filename.js";

const posixPath = fc.array(fc.constantFrom("a", "ab", ".", "..", "", "é", "two words", "..hidden"), { maxLength: 12 })
  .map((parts) => `/${parts.join("/")}`);

describe("path utility fast paths", () => {
  it.skipIf(process.platform === "win32")("matches normalized containment for absolute roots with trailing separators", () => {
    fc.assert(fc.property(posixPath, posixPath, (root, target) => {
      const relative = path.posix.relative(root, target);
      const expected = relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
      expect(isPathInside(root, target), `${root} -> ${target}`).toBe(expected);
      expect(isPathInside(`${root}/`, target), `${root}/ -> ${target}`).toBe(expected);
    }), { numRuns: 4000, seed: 1701 });
  });

  it.skipIf(process.platform === "win32")("checks the segment boundary and parent traversal after a prefix match", () => {
    for (const root of ["/safe", "/safe/", "/safe//", "/safe/./"]) {
      expect(isPathInside(root, "/safe/child")).toBe(true);
      expect(isPathInside(root, "/safe/child/../../outside")).toBe(false);
      expect(isPathInside(root, "/safe-neighbor/file")).toBe(false);
    }
    expect(isPathInside("/", "/any/path")).toBe(true);
  });

  it("keeps ordinary install names exact and preserves collision-resistant suffixes", () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 10);
    expect(safePathSegmentHashed(" ordinary-safe-name ")).toBe("ordinary-safe-name");
    expect(safePathSegmentHashed("a".repeat(60))).toBe("a".repeat(60));
    const long = "a".repeat(61);
    expect(safePathSegmentHashed(long)).toBe(`${"a".repeat(50)}-${hash(long)}`);
    expect(safePathSegmentHashed("two names")).toBe(`two-names-${hash("two names")}`);
    expect(safePathSegmentHashed("two/names")).toBe(`two-names-${hash("two/names")}`);
    expect(safePathSegmentHashed("..")).toBe(`skill-${hash("..")}`);
  });

  it("strips every forbidden control without changing ordinary Unicode", () => {
    const controls = Array.from({ length: 0xa0 }, (_, value) => value)
      .filter((value) => value < 0x20 || value >= 0x7f)
      .map((value) => String.fromCharCode(value)).join("");
    expect(sanitizeUntrustedFileName(`report${controls}é😀.txt`, "fallback")).toBe("reporté😀.txt");
    expect(sanitizeUntrustedFileName('re<>:"|?*port.txt', "fallback")).toBe("report.txt");
  });
});
