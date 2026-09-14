import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isWindowsReservedDeviceName,
  WINDOWS_RESERVED_DEVICE_NAMES,
} from "../src/device-path.js";
import { sanitizeUntrustedFileName } from "../src/filename.js";
import { writeSiblingTempFile, writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { sanitizeTempFileName, tempFile } from "../src/temp-target.js";
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
  it.each([199, 200])(
    "keeps a padded reserved basename safe at the %i-code-unit boundary",
    (length) => {
      const input = `CON${" ".repeat(length - 3)}`;
      expect(input).toHaveLength(length);
      expectPortableSanitizedName(input);
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
    } finally {
      await target.cleanup();
    }
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

    await expect(writeViaSiblingTempPath({
      rootDir,
      targetPath,
      tempPrefix: "NUL.",
      writeTemp: producer,
    })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
    expect(producer).not.toHaveBeenCalled();
    await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });
});
