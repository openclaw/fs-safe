import { describe, expect, it } from "vitest";
import { sanitizeUntrustedFileName } from "../src/filename.js";
import { isWindowsDriveLetterPath, isWindowsNetworkPath } from "../src/local-file-access.js";
import { assertNoWindowsPathAlias, hasWindowsPathAlias } from "../src/windows-path-alias.js";

const prefixCases = [
  { value: "", alias: false, network: false, drive: false, filename: "fallback" },
  { value: "C:", alias: true, network: false, drive: false, filename: "fallback" },
  { value: "C:report.txt", alias: true, network: false, drive: false, filename: "report.txt" },
  { value: "z:/folder/report.txt", alias: false, network: false, drive: true, filename: "report.txt" },
  { value: "C:\\report.txt:stream", alias: true, network: false, drive: true, filename: "report.txtstream" },
  { value: "\\\\?\\C:\\report.txt", alias: false, network: false, drive: false, filename: "report.txt" },
  { value: "\\\\.\\C:\\report.txt", alias: false, network: true, drive: false, filename: "report.txt" },
  { value: "\\\\?\\UNC\\server\\share\\report.txt", alias: false, network: true, drive: false, filename: "report.txt" },
  { value: "\\\\server:443\\share\\report.txt", alias: true, network: true, drive: false, filename: "report.txt" },
  ...["@", "[", "`", "{", "é", "K", "ſ", "ı", "\ud800", "\udfff", "😀"].map(letter => ({
    value: `${letter}:report.txt`, alias: true, network: false, drive: false, filename: `${letter}report.txt`,
  })),
];

describe("shared Windows prefix syntax with separate caller policies", () => {
  it.each(prefixCases)("preserves each policy for $value", ({ value, alias, network, drive, filename }) => {
    expect(hasWindowsPathAlias(value, "filesystem", "win32")).toBe(alias);
    expect(hasWindowsPathAlias(value, "relative", "win32")).toBe(value.includes(":"));
    expect(isWindowsNetworkPath(value, "win32")).toBe(network);
    expect(isWindowsDriveLetterPath(value, "win32")).toBe(drive);
    expect(sanitizeUntrustedFileName(value, "fallback")).toBe(filename);
    expect(sanitizeUntrustedFileName("<>", value)).toBe(filename === "fallback" ? "file" : filename);
    for (const platform of ["linux", "darwin"] as const) {
      expect(hasWindowsPathAlias(value, "filesystem", platform)).toBe(false);
      expect(isWindowsNetworkPath(value, platform)).toBe(false);
      expect(isWindowsDriveLetterPath(value, platform)).toBe(false);
    }
    if (alias) {
      expect(() => assertNoWindowsPathAlias(value, "filesystem", "prefix fixture", "win32"))
        .toThrow(expect.objectContaining({
          name: "FsSafeError", message: "prefix fixture", code: "invalid-path",
          details: { reason: "windows-path-alias" },
        }));
    }
  });

  it("requires the complete rooted drive before exempting a question-mark namespace", () => {
    const namespaceRoot = "\\\\?\\C:\\";
    for (let length = 0; length <= namespaceRoot.length; length += 1) {
      const prefix = namespaceRoot.slice(0, length);
      expect(isWindowsNetworkPath(prefix, "win32"), prefix).toBe(length >= 2 && length < 7);
      expect(hasWindowsPathAlias(prefix, "filesystem", "win32"), prefix).toBe(length === 6);
    }
    for (const value of ["\\\\?\\C:relative", "\\\\?\\K:\\", "\\\\?\\\ud800:\\"]) {
      expect(isWindowsNetworkPath(value, "win32"), value).toBe(true);
      expect(hasWindowsPathAlias(value, "filesystem", "win32"), value).toBe(true);
    }
  });

  it("admits mixed prefix separators without normalizing a later parent or stream component", () => {
    for (const first of ["/", "\\"]) for (const second of ["/", "\\"]) {
      for (const marker of ["?", "."]) for (const third of ["/", "\\"]) {
        for (const separator of ["/", "\\"]) {
          const prefix = `${first}${second}${marker}${third}C:${separator}`;
          const value = `${prefix}parent${separator}..${separator}report.txt`;
          expect(hasWindowsPathAlias(value, "filesystem", "win32"), value).toBe(false);
          expect(isWindowsNetworkPath(value, "win32"), value).toBe(marker === ".");
          expect(sanitizeUntrustedFileName(value, "fallback"), value).toBe("report.txt");
          const stream = `${prefix}parent:stream${separator}..${separator}report.txt`;
          expect(hasWindowsPathAlias(stream, "filesystem", "win32"), stream).toBe(true);
        }
      }
    }
  });

  it("retains coercion only in the existing public drive-letter regexp predicate", () => {
    const drive = { toString: () => "C:/report.txt" } as unknown as string;
    expect(isWindowsDriveLetterPath(drive, "win32")).toBe(true);
    expect(isWindowsDriveLetterPath(drive, "linux")).toBe(false);
    for (const value of [null, undefined, 42] as unknown as string[]) {
      expect(isWindowsDriveLetterPath(value, "win32")).toBe(false);
    }
  });
});
