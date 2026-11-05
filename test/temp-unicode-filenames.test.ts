import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWindowsReservedDeviceName } from "../src/device-path.js";
import { isSafePathSegment, normalizeSafePathSegment } from "../src/safe-path-segment.js";
import { sanitizeTempFileName, tempFile } from "../src/temp-target.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();

describe("Unicode temp filenames", () => {
  it.each(["中文文件名测试（出站验证）.txt", "café.txt", "cafe\u0301.txt", "📄.txt"])(
    "preserves and writes %s through both temp file paths",
    async (name) => {
      expect(sanitizeTempFileName(name)).toBe(name);
      const rootDir = await tempRoot("fs-safe-unicode-temp-");
      const target = await tempFile({ rootDir, prefix: "unicode", fileName: name });
      try {
        expect(path.basename(target.path)).toBe(name);
        expect(target.file(name)).toBe(target.path);
        await fs.writeFile(target.path, "initial");
        await expect(fs.readFile(target.file(name), "utf8")).resolves.toBe("initial");
        const another = target.file(`另一个-${name}`);
        expect(path.dirname(another)).toBe(target.dir);
        await fs.writeFile(another, "another");
        await expect(fs.readFile(another, "utf8")).resolves.toBe("another");
      } finally {
        await target.cleanup();
      }
    },
  );

  it.each([`${"中".repeat(200)}.txt`, `${"é".repeat(200)}.txt`, `${"📄".repeat(100)}.txt`])(
    "bounds long names in raw, NFC, and NFD UTF-8 without losing the extension",
    async (name) => {
      const safe = sanitizeTempFileName(name);
      expect(safe.startsWith(Array.from(name)[0]!)).toBe(true);
      expect(safe.endsWith(".txt")).toBe(true);
      expect(safe.isWellFormed()).toBe(true);
      for (const form of [safe, safe.normalize("NFC"), safe.normalize("NFD")]) {
        expect(Buffer.byteLength(form)).toBeLessThanOrEqual(255);
      }
      expect(sanitizeTempFileName(safe)).toBe(safe);
      const rootDir = await tempRoot("fs-safe-unicode-long-");
      const target = await tempFile({ rootDir, prefix: "unicode", fileName: name });
      try {
        await fs.writeFile(target.path, "long");
        await expect(fs.readFile(target.path, "utf8")).resolves.toBe("long");
      } finally {
        await target.cleanup();
      }
    },
  );

  it.each([
    ["../../中文.txt", "中文.txt"],
    ["中文\\..\\file.txt", process.platform === "win32" ? "file.txt" : "中文-..-file.txt"],
    ["中文\0.txt", "中文.txt"],
    ["中文\n\u0085\u202e\ud800.txt", "中文-.txt"],
    ["中文:stream?*.txt", "中文-stream-.txt"],
    ["COM¹.txt", "COM¹_.txt"],
    ["LPT².txt", "LPT²_.txt"],
    ["file≮≯.txt", "file--.txt"],
    ["..", "download.bin"],
  ])("keeps path and control filtering for %j", (input, expected) => {
    const safe = sanitizeTempFileName(input);
    expect(safe).toBe(expected);
    expect(safe).toBe(path.posix.basename(safe));
    expect(safe).toBe(path.win32.basename(safe));
    expect(/[\p{Cc}\p{Cf}\p{Cs}\s<>:"/\\|?*]/u.test(safe)).toBe(false);
    expect(isWindowsReservedDeviceName(safe)).toBe(false);
    expect(/[<>:"/\\|?*]/u.test(safe.normalize("NFD"))).toBe(false);
    expect(sanitizeTempFileName(safe)).toBe(safe);
  });

  it("remains idempotent when truncation exposes an edge hyphen", () => {
    const safe = sanitizeTempFileName(`${"a".repeat(254)}-x`);
    expect(safe).toBe("a".repeat(254));
    expect(sanitizeTempFileName(safe)).toBe(safe);
  });

  it("keeps the separate ASCII identifier contract", () => {
    expect(isSafePathSegment("中文.txt", { allowDotPrefix: true })).toBe(false);
    expect(normalizeSafePathSegment("café.txt")).toBe("caf-.txt");
  });
});
