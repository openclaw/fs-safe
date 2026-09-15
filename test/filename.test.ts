import { describe, expect, it } from "vitest";
import {
  isWindowsReservedDeviceName,
  isUnsafeDeviceReadPath,
  WINDOWS_RESERVED_DEVICE_NAMES,
} from "../src/device-path.js";
import { fitFileNameToPortableComponent, sanitizeUntrustedFileName } from "../src/filename.js";

function mixedCase(value: string): string {
  return Array.from(value, (character, index) =>
    index % 2 === 0 ? character : character.toLowerCase()
  ).join("");
}

function normalizedBytes(value: string): number {
  return Math.max(Buffer.byteLength(value.normalize("NFC")), Buffer.byteLength(value.normalize("NFD")));
}

type CandidatePosition = "primary" | "fallback";

function sanitizeAtPosition(position: CandidatePosition, candidate: string): string {
  return position === "primary"
    ? sanitizeUntrustedFileName(candidate, "fallback.bin")
    : sanitizeUntrustedFileName("<>", candidate);
}

describe("fitFileNameToPortableComponent", () => {
  const prefix = `.fs-safe-output-12345-${"a".repeat(36)}-`;
  const suffix = ".part";

  it("keeps short callback names exact", () => {
    expect(fitFileNameToPortableComponent({ prefix, fileName: "report.tar.gz", suffix }))
      .toBe("report.tar.gz");
  });

  it.each([
    `${"a".repeat(195)}.json`,
    `${"é".repeat(100)}.json`,
    `${"가".repeat(65)}.json`,
    `${"K".repeat(80)}.json`,
    `${"\u037e".repeat(120)}.json`,
  ])("fits %s under NFC and NFD byte limits while preserving the extension", (fileName) => {
    const fitted = fitFileNameToPortableComponent({ prefix, fileName, suffix });
    expect(fitted).toMatch(/\.json$/u);
    expect(normalizedBytes(`${prefix}${fitted}${suffix}`)).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(`${prefix}${fitted}${suffix}`)).toBeLessThanOrEqual(255);
    expect(fitted.length).toBeLessThan(fileName.length);
  });
});

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

  it.each(["<>", '"*|?', "\u0000\u001f\u007f"])(
    "keeps a fully removable non-path ASCII candidate unusable: %j",
    (candidate) => {
      expect(sanitizeAtPosition("primary", candidate)).toBe("fallback.bin");
      expect(sanitizeAtPosition("fallback", candidate)).toBe("file");
    },
  );

  it("retains the complete sanitizer for mixed and path-like ASCII candidates", () => {
    expect(sanitizeUntrustedFileName("<>report?.txt", "fallback.bin")).toBe("report.txt");
    expect(sanitizeUntrustedFileName("<>/nested/final?.txt", "fallback.bin"))
      .toBe("final.txt");
    expect(sanitizeUntrustedFileName("<>\\nested\\final?.txt", "fallback.bin"))
      .toBe("final.txt");
    expect(sanitizeUntrustedFileName(":", "fallback.bin")).toBe("fallback.bin");
  });

  it("leaves a valid primary name unchanged without exposing an unsafe fallback", () => {
    expect(sanitizeUntrustedFileName("report.txt", "../../outside.txt")).toBe("report.txt");
  });

  it.each([
    ["safe Unicode", `${"é".repeat(196)}.txt`, `${"é".repeat(196)}.txt`],
    ["199-character ASCII", "a".repeat(199), "a".repeat(199)],
    ["200-character ASCII", "a".repeat(200), "a".repeat(200)],
    ["Windows device", "cOn.TxT", "cOn_.TxT"],
    ["padded Windows device", `CON${" ".repeat(193)}.txt`, `CON${" ".repeat(193)}_.tx`],
    ["invalid characters", 're<>:"|?*port.txt', "report.txt"],
    ["path", "../nested/report.txt", "report.txt"],
    ["trimmed name", " report.txt ", "report.txt"],
    ["overlength name", "a".repeat(201), "a".repeat(200)],
    ["surrogate boundary", `${"a".repeat(199)}😀`, "a".repeat(199)],
  ])("keeps %s candidate behavior identical in primary and fallback positions", (
    _label,
    candidate,
    expected,
  ) => {
    expect(sanitizeAtPosition("primary", candidate)).toBe(expected);
    expect(sanitizeAtPosition("fallback", candidate)).toBe(expected);
  });

  it.each([".", ".."])("keeps dot alias %j unusable in either candidate position", (candidate) => {
    expect(sanitizeAtPosition("primary", candidate)).toBe("fallback.bin");
    expect(sanitizeAtPosition("fallback", candidate)).toBe("file");
  });

  it.each(["primary", "fallback"] as const)(
    "keeps a 200-character safe ASCII %s candidate exact",
    (position) => {
      const candidate = "a".repeat(200);
      expect(sanitizeAtPosition(position, candidate)).toBe(candidate);
    },
  );

  it.each(["primary", "fallback"] as const)(
    "strips a final newline and CRLF from a %s candidate",
    (position) => {
      expect(sanitizeAtPosition(position, "report.txt\n")).toBe("report.txt");
      expect(sanitizeAtPosition(position, "report.txt\r\n")).toBe("report.txt");
    },
  );

  it.each(["primary", "fallback"] as const)(
    "does not admit dot aliases from a %s candidate",
    (position) => {
      const replacement = position === "primary" ? "fallback.bin" : "file";
      expect(sanitizeAtPosition(position, ".")).toBe(replacement);
      expect(sanitizeAtPosition(position, "..")).toBe(replacement);
    },
  );

  it.each(["primary", "fallback"] as const)(
    "suffixes a mixed-case Windows device %s candidate",
    (position) => {
      expect(sanitizeAtPosition(position, "cOn.TxT")).toBe("cOn_.TxT");
    },
  );

  it.each([
    ["../nested/portable.txt", "portable.txt"],
    ["..\\nested\\windows.txt", "windows.txt"],
    ["safe\u0000\u001f\u0085name?.txt", "safename.txt"],
  ])("sanitizes fallback %j through the filename pipeline", (fallback, expected) => {
    expect(sanitizeUntrustedFileName("<>", fallback)).toBe(expected);
  });

  it("applies reserved-device and length rules to fallbacks", () => {
    expect(sanitizeUntrustedFileName("", "CON.txt")).toBe("CON_.txt");
    expect(sanitizeUntrustedFileName("", "a".repeat(220))).toBe("a".repeat(200));
  });

  it("keeps the final truncated primary and fallback names device-safe", () => {
    const paddedDevice = `CON${" ".repeat(197)}.txt`;
    for (const sanitized of [
      sanitizeUntrustedFileName(paddedDevice, "fallback.bin"),
      sanitizeUntrustedFileName("<>", paddedDevice),
    ]) {
      expect(sanitized.length).toBeLessThanOrEqual(200);
      expect(isWindowsReservedDeviceName(sanitized)).toBe(false);
      expect(isUnsafeDeviceReadPath(`C:\\tmp\\${sanitized}`, { platform: "win32" })).toBe(false);
    }
  });

  it("uses a fixed safe literal when both primary and fallback are unusable", () => {
    expect(sanitizeUntrustedFileName("<>", "../..")).toBe("file");
    expect(sanitizeUntrustedFileName(".", "\u0000<>\t")).toBe("file");
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
      expect(sanitizeUntrustedFileName("<>", reservedName)).toBe(`${reservedName}_`);
      expect(sanitizeUntrustedFileName("<>", `${casedName}.TxT`)).toBe(`${casedName}_.TxT`);
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
      for (const sanitized of [
        sanitizeUntrustedFileName(input, "fallback.bin"),
        sanitizeUntrustedFileName("<>", input),
      ]) {
        expect(isUnsafeDeviceReadPath(`C:\\tmp\\${sanitized}`, { platform: "win32" }), input)
          .toBe(false);
      }
    }
  });

  it.each(["primary", "fallback"] as const)(
    "suffixes a 200-character reserved %s candidate without truncating the safety suffix",
    (position) => {
      const input = `CON.${"a".repeat(196)}`;
      const expected = `CON_.${"a".repeat(195)}`;
      expect(input).toHaveLength(200);
      expect(expected).toHaveLength(200);
      expect(sanitizeAtPosition(position, input)).toBe(expected);
    },
  );

  it("does not split a Unicode surrogate pair at the length limit", () => {
    const sanitized = sanitizeUntrustedFileName(`${"a".repeat(199)}😀`, "fallback.bin");
    expect(sanitized.isWellFormed()).toBe(true);
    expect(sanitized).toBe("a".repeat(199));
  });

  it("keeps a truncated device fallback well-formed and device-safe", () => {
    const sanitized = sanitizeUntrustedFileName("<>", `CON${" ".repeat(196)}😀`);
    expect(sanitized.isWellFormed()).toBe(true);
    expect(sanitized).toBe(`CON${" ".repeat(196)}_`);
    expect(isWindowsReservedDeviceName(sanitized)).toBe(false);
  });

  it.each(["CON", "nul.txt", "CoNiN$.log", "COM¹.dat", "CON_"])(
    "is idempotent for reserved-name result %s",
    (input) => {
      const once = sanitizeUntrustedFileName(input, "fallback.bin");
      expect(sanitizeUntrustedFileName(once, "fallback.bin")).toBe(once);
    },
  );
});
