import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { isUnsafeDeviceReadPath } from "../src/device-path.js";
import { sanitizeSafePathSegment } from "../src/safe-path-segment.js";
import { buildRandomTempFilePath } from "../src/temp-target.js";

const ADVERSARIAL_RUN_LENGTH = 100_000;
const MAX_LINEAR_SCAN_MS = 1_000;

function expectBounded<T>(run: () => T): T {
  const startedAt = performance.now();
  const result = run();
  expect(performance.now() - startedAt).toBeLessThan(MAX_LINEAR_SCAN_MS);
  return result;
}

describe("CodeQL ReDoS regressions", () => {
  it("handles long internal Windows separator runs in linear time", () => {
    const separators = "\\".repeat(ADVERSARIAL_RUN_LENGTH);

    expect(
      expectBounded(() =>
        isUnsafeDeviceReadPath(`C:\\tmp\\${separators}normal.txt`, {
          platform: "win32",
        }),
      ),
    ).toBe(false);
    expect(
      expectBounded(() =>
        isUnsafeDeviceReadPath(`C:\\tmp\\${separators}NUL`, {
          platform: "win32",
        }),
      ),
    ).toBe(true);
  });

  it("preserves long internal hyphen runs while trimming only edges", () => {
    const internalHyphens = `a${"-".repeat(ADVERSARIAL_RUN_LENGTH)}b`;

    expect(
      expectBounded(() => sanitizeSafePathSegment(internalHyphens, "fallback")),
    ).toBe(internalHyphens);
    expect(sanitizeSafePathSegment(`---${internalHyphens}---`, "fallback")).toBe(
      internalHyphens,
    );
  });

  it("sanitizes long temp prefixes and extension candidates in linear time", () => {
    const internalHyphens = `a${"-".repeat(ADVERSARIAL_RUN_LENGTH)}b`;
    const prefixed = expectBounded(() =>
      buildRandomTempFilePath({
        rootDir: process.cwd(),
        prefix: internalHyphens,
        now: 1,
        uuid: "id",
      }),
    );
    expect(path.basename(prefixed)).toBe(`${internalHyphens}-1-id`);

    const invalidExtension = expectBounded(() =>
      buildRandomTempFilePath({
        rootDir: process.cwd(),
        prefix: "tmp",
        extension: `${"a".repeat(ADVERSARIAL_RUN_LENGTH)}!`,
        now: 1,
        uuid: "id",
      }),
    );
    expect(path.basename(invalidExtension)).toBe("tmp-1-id");

    expect(
      path.basename(
        buildRandomTempFilePath({
          rootDir: process.cwd(),
          prefix: "tmp",
          extension: `${".".repeat(ADVERSARIAL_RUN_LENGTH)}log`,
          now: 1,
          uuid: "id",
        }),
      ),
    ).toBe("tmp-1-id.log");
  });
});
