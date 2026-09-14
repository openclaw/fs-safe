import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isWindowsReservedDeviceName,
  WINDOWS_RESERVED_DEVICE_NAMES,
} from "../src/device-path.js";
import {
  sanitizeUntrustedFileName,
  suffixWindowsReservedDeviceName,
} from "../src/filename.js";
import { writeSiblingTempFile, writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { sanitizeTempFileName, tempFile } from "../src/temp-target.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function mixedCase(value: string): string {
  return Array.from(value, (character, index) =>
    index % 2 === 0 ? character : character.toLowerCase()
  ).join("");
}

function expectPortableSanitizedName(input: string): string {
  const result = sanitizeUntrustedFileName(input, "fallback.bin");
  expect(result.length).toBeLessThanOrEqual(200);
  expect(result.isWellFormed()).toBe(true);
  expect(isWindowsReservedDeviceName(result), input).toBe(false);
  expect(sanitizeUntrustedFileName(result, "fallback.bin")).toBe(result);
  return result;
}

describe("Windows device-safe generated filenames", () => {
  it.each([
    "ordinary-safe-name.json",
    "console.txt",
    "COM0.log",
    "COM10.log",
    "LPT0.log",
    "PRNTER.txt",
    "CLOCK$$.txt",
    "CONOUT.txt",
  ])("keeps the non-device near miss %s exact", (name) => {
    expect(suffixWindowsReservedDeviceName(name)).toBe(name);
    expect(sanitizeUntrustedFileName(name, "fallback.bin")).toBe(name);
  });

  it("preserves ignored padding and extensions while suffixing the original stem", () => {
    expect(suffixWindowsReservedDeviceName("cOn   .TxT")).toBe("cOn   _.TxT");
    expect(suffixWindowsReservedDeviceName("NUL...")).toBe("NUL_...");
  });

  it("preserves Unicode casing behavior and non-ASCII initial near misses", () => {
    expect(suffixWindowsReservedDeviceName("con\u0131n$.txt")).toBe("con\u0131n$_.txt");
    for (const name of ["\u017fON.txt", "\u212aON.txt", "\uff23ON.txt"]) {
      expect(suffixWindowsReservedDeviceName(name)).toBe(name);
      expect(sanitizeUntrustedFileName(name, "fallback.bin")).toBe(name);
    }
  });

  it("keeps malformed surrogate input behavior bounded and device-safe", () => {
    const leadingLoneSurrogate = "\ud800ON.txt";
    expect(suffixWindowsReservedDeviceName(leadingLoneSurrogate)).toBe(leadingLoneSurrogate);
    expect(sanitizeUntrustedFileName(leadingLoneSurrogate, "fallback.bin"))
      .toBe(leadingLoneSurrogate);

    const truncatedLoneSurrogate = `${"a".repeat(199)}\ud800x`;
    expect(sanitizeUntrustedFileName(truncatedLoneSurrogate, "fallback.bin"))
      .toBe("a".repeat(199));
  });

  it.each([199, 200])(
    "keeps a padded reserved basename safe at the %i-code-unit boundary",
    (length) => {
      const input = `CON${" ".repeat(length - 7)}.txt`;
      expect(input).toHaveLength(length);
      const expectedExtension = length === 199 ? ".txt" : ".tx";
      expect(expectPortableSanitizedName(input)).toBe(
        `CON${" ".repeat(length - 7)}_${expectedExtension}`,
      );
    },
  );

  it("rechecks a reserved basename exposed only by truncation", () => {
    const input = `CON${" ".repeat(197)}x`;
    expect(input).toHaveLength(201);
    expectPortableSanitizedName(input);
  });

  it.each([...WINDOWS_RESERVED_DEVICE_NAMES])(
    "rechecks padded and cased %s after truncation",
    (device) => {
      const cased = mixedCase(device);
      const input = `${cased}${" ".repeat(200 - cased.length)}x`;
      expect(input).toHaveLength(201);
      expectPortableSanitizedName(input);
    },
  );

  it("keeps padding, extensions, and surrogate-safe truncation device-safe", () => {
    expectPortableSanitizedName(`nUl${" ".repeat(197)}.txt`);
    expectPortableSanitizedName(`CON${" ".repeat(196)}😀`);
    expect(expectPortableSanitizedName(`CON${" ".repeat(195)}😀x`))
      .toBe(`CON${" ".repeat(195)}😀`);
  });

  it.each([...WINDOWS_RESERVED_DEVICE_NAMES])(
    "device-protects sanitizeTempFileName output for %s",
    (device) => {
      for (const input of [device, `${mixedCase(device)}.txt`, `${device}...`]) {
        const sanitized = sanitizeTempFileName(input);
        expect(isWindowsReservedDeviceName(sanitized), input).toBe(false);
      }
    },
  );

  it("device-protects the default path and file() paths in a temp workspace", async () => {
    const rootDir = await tempRoot("fs-safe-device-temp-");
    const target = await tempFile({ rootDir, prefix: "device", fileName: "CON.txt" });
    try {
      expect(path.basename(target.path)).toBe("CON_.txt");
      expect(path.basename(target.file("nul.log"))).toBe("nul_.log");
      expect(isWindowsReservedDeviceName(target.path)).toBe(false);
      expect(isWindowsReservedDeviceName(target.file("nul.log"))).toBe(false);
      await fs.writeFile(target.path, "default");
      await fs.writeFile(target.file("nul.log"), "named");
      await expect(fs.readFile(target.path, "utf8")).resolves.toBe("default");
      await expect(fs.readFile(target.file("nul.log"), "utf8")).resolves.toBe("named");
    } finally {
      await target.cleanup();
    }
  });

  it("publishes through an ordinary device-safe sibling prefix", async () => {
    const rootDir = await tempRoot("fs-safe-device-safe-prefix-");
    const dir = path.join(rootDir, "parent.with.dots");
    const finalPath = path.join(dir, "published.bin");
    const published = await writeSiblingTempFile({
      dir,
      tempPrefix: "safe-output",
      writeTemp: async (tempPath) => {
        await fs.writeFile(tempPath, "published");
        return finalPath;
      },
      resolveFinalPath: (result) => result,
    });

    expect(published.filePath).toBe(finalPath);
    await expect(fs.readFile(finalPath, "utf8")).resolves.toBe("published");
  });

  it("distinguishes a device-looking prefix continuation from a device stem", async () => {
    const dir = await tempRoot("fs-safe-device-prefix-composition-");
    const producer = vi.fn(async (tempPath: string) => {
      await fs.writeFile(tempPath, "safe");
      return path.join(dir, "published.bin");
    });

    await expect(writeSiblingTempFile({
      dir,
      tempPrefix: "CON-",
      writeTemp: producer,
      resolveFinalPath: (result) => result,
    })).resolves.toMatchObject({ filePath: path.join(dir, "published.bin") });
    expect(producer).toHaveBeenCalledOnce();

    producer.mockClear();
    await expect(writeSiblingTempFile({
      dir,
      tempPrefix: "CON.",
      writeTemp: producer,
      resolveFinalPath: (result) => result,
    })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
    expect(producer).not.toHaveBeenCalled();
  });

  it.each([undefined, "private-directory"] as const)(
    "rejects a completed reserved sibling component before the %s producer",
    async (producerIsolation) => {
      const dir = await tempRoot("fs-safe-device-sibling-");
      const producer = vi.fn(async (tempPath: string) => {
        await fs.writeFile(tempPath, "unexpected");
      });
      const resolveFinalPath = vi.fn(() => path.join(dir, "final.bin"));

      await expect(writeSiblingTempFile({
        dir,
        tempPrefix: "CON",
        producerIsolation,
        writeTemp: producer,
        resolveFinalPath,
      })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
      expect(producer).not.toHaveBeenCalled();
      expect(resolveFinalPath).not.toHaveBeenCalled();
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    },
  );

  it("rejects a reserved private-workspace sibling before hooks or producers", async () => {
    const rootDir = await tempRoot("fs-safe-device-private-sibling-");
    const targetPath = path.join(rootDir, "final.bin");
    const producer = vi.fn(async (tempPath: string) => {
      await fs.writeFile(tempPath, "unexpected");
    });
    const beforeWrite = vi.fn();
    __setFsSafeTestHooksForTest({ beforeSiblingTempWrite: beforeWrite });

    try {
      await expect(writeViaSiblingTempPath({
        rootDir,
        targetPath,
        tempPrefix: "NUL.",
        writeTemp: producer,
      })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(producer).not.toHaveBeenCalled();
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(rootDir)).resolves.toEqual([]);
    } finally {
      __setFsSafeTestHooksForTest();
    }
  });
});
