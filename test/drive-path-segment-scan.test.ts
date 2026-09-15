import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  assertNoDriveRelativePathSegments,
  isDriveRelativePath,
} from "../src/safe-path-segment.js";

describe("drive-relative path segment scanning", () => {
  it("rejects drive-like components at every forward-slash boundary", () => {
    for (const value of ["C:", "c:file", "C:/file", "a/C:", "a/C:/file", "/a//Z:../file"]) {
      expect(() => assertNoDriveRelativePathSegments(value, "destination"), value).toThrowError(
        new FsSafeError("invalid-path", "destination must not contain a drive letter"),
      );
    }
  });

  it("leaves accepted spellings unchanged, including colons and backslashes", () => {
    for (const value of [
      "", "reports/today.json", "logs/2026-09-15T12:34:56Z.json", "folder/ab:cd",
      "folder/:name", "C:\\file", "folder/C:\\file", "a\\C:file", "é:file", "0:file",
    ]) {
      expect(assertNoDriveRelativePathSegments(value, "destination"), value).toBe(value);
    }
  });

  it("matches per-segment classification for arbitrary path spellings", () => {
    const spelling = fc.array(
      fc.constantFrom("a", "Z", ":", "/", "\\", ".", "0", "\0", "\n", "é", "😀"),
      { maxLength: 100 },
    ).map((parts) => parts.join(""));
    fc.assert(fc.property(spelling, (value) => {
      const rejected = value.split("/").some(isDriveRelativePath);
      if (rejected) {
        expect(() => assertNoDriveRelativePathSegments(value, "key")).toThrowError(
          new FsSafeError("invalid-path", "key must not contain a drive letter"),
        );
      } else {
        expect(assertNoDriveRelativePathSegments(value, "key")).toBe(value);
      }
    }), { numRuns: 5000, seed: 20260915 });
  });
});
