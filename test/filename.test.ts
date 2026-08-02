import { describe, expect, it } from "vitest";
import {
  isUnsafeDeviceReadPath,
  WINDOWS_RESERVED_DEVICE_NAMES,
} from "../src/device-path.js";
import { sanitizeUntrustedFileName } from "../src/filename.js";

function mixedCase(value: string): string {
  return Array.from(value, (character, index) =>
    index % 2 === 0 ? character : character.toLowerCase()
  ).join("");
}

describe("sanitizeUntrustedFileName", () => {
  it("keeps only the basename and strips control characters", () => {
    expect(sanitizeUntrustedFileName("../nested/rep\u0000ort.pdf", "fallback.bin")).toBe(
      "report.pdf",
    );
  });

  it("uses fallback for empty or path-alias names", () => {
    expect(sanitizeUntrustedFileName("", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName(" ", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName(".", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("..", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("<>", "fallback.bin")).toBe("fallback.bin");
  });

  it("strips C1 controls and Windows-invalid characters on every platform", () => {
    expect(
      sanitizeUntrustedFileName('re<po>r:t"|?*\u0085\u009f.pdf', "fallback.bin"),
    ).toBe("report.pdf");
  });

  it.each([...WINDOWS_RESERVED_DEVICE_NAMES])(
    "suffixes reserved basename %s while preserving case and extensions",
    (reservedName) => {
      const casedName = mixedCase(reservedName);
      expect(sanitizeUntrustedFileName(reservedName, "fallback.bin")).toBe(
        `${reservedName}_`,
      );
      expect(sanitizeUntrustedFileName(`${reservedName}.txt`, "fallback.bin")).toBe(
        `${reservedName}_.txt`,
      );
      expect(sanitizeUntrustedFileName(casedName, "fallback.bin")).toBe(`${casedName}_`);
      expect(sanitizeUntrustedFileName(`${casedName}.TxT`, "fallback.bin")).toBe(
        `${casedName}_.TxT`,
      );
    },
  );

  it("handles dollar names, superscript variants, and multi-part extensions", () => {
    expect(sanitizeUntrustedFileName("conin$", "fallback.bin")).toBe("conin$_");
    expect(sanitizeUntrustedFileName("ConOut$.log", "fallback.bin")).toBe(
      "ConOut$_.log",
    );
    expect(sanitizeUntrustedFileName("com¹.TXT", "fallback.bin")).toBe("com¹_.TXT");
    expect(sanitizeUntrustedFileName("LpT³.tar.gz", "fallback.bin")).toBe(
      "LpT³_.tar.gz",
    );
  });

  it("does not return a Windows device name disguised with ignored trailing characters", () => {
    for (const input of ["CON .", "nul .txt", "LPT1..."]) {
      const sanitized = sanitizeUntrustedFileName(input, "fallback.bin");
      expect(isUnsafeDeviceReadPath(`C:\\tmp\\${sanitized}`, { platform: "win32" }), input)
        .toBe(false);
    }
  });

  it("suffixes reserved names before applying the 200-character limit", () => {
    const input = `CON.${"a".repeat(196)}`;
    const expected = `CON_.${"a".repeat(195)}`;
    expect(input).toHaveLength(200);
    expect(expected).toHaveLength(200);
    expect(sanitizeUntrustedFileName(input, "fallback.bin")).toBe(expected);
  });

  it.each(["CON", "nul.txt", "CoNiN$.log", "COM¹.dat", "CON_"])(
    "is idempotent for reserved-name result %s",
    (input) => {
      const once = sanitizeUntrustedFileName(input, "fallback.bin");
      expect(sanitizeUntrustedFileName(once, "fallback.bin")).toBe(once);
    },
  );
});
