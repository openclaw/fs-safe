import { describe, expect, it } from "vitest";
import { sanitizeUntrustedFileName } from "../src/filename.js";

describe("sanitizeUntrustedFileName", () => {
  it("keeps only the basename and strips control characters", () => {
    expect(sanitizeUntrustedFileName("../nested/rep\u0000ort.pdf", "fallback.bin")).toBe(
      "report.pdf",
    );
  });

  it("uses fallback for empty or path-alias names", () => {
    expect(sanitizeUntrustedFileName(" ", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("..", "fallback.bin")).toBe("fallback.bin");
  });

  it("strips C1 controls and Windows-invalid characters on every platform", () => {
    expect(
      sanitizeUntrustedFileName('re<po>r:t"|?*\u0085\u009f.pdf', "fallback.bin"),
    ).toBe("report.pdf");
  });

  it("rejects Windows reserved device basenames", () => {
    expect(sanitizeUntrustedFileName("CON", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("nul.txt", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("COM1", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("LPT9.doc", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("aux ", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("PRN.backup", "fallback.bin")).toBe("fallback.bin");
    // Not reserved: longer names that only contain reserved tokens as a prefix/suffix.
    expect(sanitizeUntrustedFileName("console.txt", "fallback.bin")).toBe("console.txt");
    expect(sanitizeUntrustedFileName("null.pdf", "fallback.bin")).toBe("null.pdf");
  });
});
