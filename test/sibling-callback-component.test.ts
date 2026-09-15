import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "../src/device-path.js";
import {
  resolveCallbackTempPath,
  writeCallbackSibling,
} from "../src/sibling-staged-file.js";
import { writeSiblingTempFile, writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

describe("sibling callback temp components", () => {
  const workspaceDir = path.resolve("virtual-callback-workspace");

  it("joins a valid completed component as a direct workspace child", () => {
    const resolved = resolveCallbackTempPath(workspaceDir, ".stage report-é.part");

    expect(resolved).toBe(path.join(workspaceDir, ".stage report-é.part"));
    expect(path.dirname(resolved)).toBe(workspaceDir);
  });

  it.each([
    "",
    ".",
    "..",
    "nested/file.part",
    "nested\\file.part",
    "stage\u0000.part",
    "stage\u001f.part",
    "stage\u007f.part",
    "stage\u0085.part",
    "stage:stream.part",
    "C:stage.part",
    "stage<bad>.part",
    "stage|pipe.part",
    "stage?.part",
    "stage.part.",
    "stage.part ",
    "CON",
    "con.txt",
    "COM¹.log",
    "LPT³ .txt",
  ])("rejects non-component callback name %j on every host", (component) => {
    let failure: unknown;
    try {
      resolveCallbackTempPath(workspaceDir, component);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid-path", category: "policy" });
  });

  it.each([...WINDOWS_RESERVED_DEVICE_NAMES])(
    "rejects Windows device completion %s on every host",
    (device) => {
      let failure: unknown;
      try {
        resolveCallbackTempPath(workspaceDir, `${device}.tmp`);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid-path", category: "policy" });
    },
  );

  it.each([
    ["ordinary POSIX-separator", undefined, "nested/escape.part"],
    ["ordinary Windows-separator", undefined, "nested\\escape.part"],
    ["ordinary control", undefined, "stage\u0000.part"],
    ["isolated POSIX-separator", "private-directory", "nested/escape.part"],
    ["isolated Windows-separator", "private-directory", "nested\\escape.part"],
    ["isolated control", "private-directory", "stage\u0085.part"],
  ] as const)("rejects an invalid %s completion before calling the producer", async (
    _,
    isolation,
    tempName,
  ) => {
    const producer = vi.fn(async () => undefined);

    await expect(writeCallbackSibling({
      tempDir: workspaceDir,
      tempName,
      write: producer,
      producerIsolation: isolation,
      resolveFinalPath: () => path.join(workspaceDir, "final.bin"),
      syncTempFile: false,
      syncParentDir: false,
    })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
    expect(producer).not.toHaveBeenCalled();
  });

  it.each([undefined, "private-directory"] as const)(
    "rejects reserved writeSiblingTempFile prefixes before the %s producer",
    async (producerIsolation) => {
      const dir = await tempRoot("fs-safe-reserved-sibling-");
      const producer = vi.fn(async () => undefined);

      await expect(writeSiblingTempFile({
        dir,
        tempPrefix: "CON",
        producerIsolation,
        writeTemp: producer,
        resolveFinalPath: () => path.join(dir, "final.bin"),
      })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
      expect(producer).not.toHaveBeenCalled();
    },
  );

  it("rejects a reserved writeViaSiblingTempPath completion before its hook or producer", async () => {
    const rootDir = await tempRoot("fs-safe-reserved-private-sibling-");
    const hook = vi.fn();
    const producer = vi.fn(async () => undefined);
    __setFsSafeTestHooksForTest({ beforeSiblingTempWrite: hook });

    await expect(writeViaSiblingTempPath({
      rootDir,
      targetPath: path.join(rootDir, "final.bin"),
      tempPrefix: "CON.",
      writeTemp: producer,
    })).rejects.toMatchObject({ code: "invalid-path", category: "policy" });
    expect(hook).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });

  it("keeps an unsafe fallback inside the owned private sibling workspace", async () => {
    const rootDir = await tempRoot("fs-safe-fallback-sibling-");
    const failure = new Error("stop after observing the callback path");
    let observedPath: string | undefined;

    await expect(writeViaSiblingTempPath({
      rootDir,
      targetPath: path.join(rootDir, "<>"),
      fallbackFileName: "../../../../outside.bin",
      writeTemp: async (tempPath) => {
        observedPath = tempPath;
        throw failure;
      },
    })).rejects.toBe(failure);

    expect(observedPath).toBeDefined();
    const workspaceDir = path.dirname(observedPath!);
    expect(path.basename(workspaceDir)).toMatch(/^fs-safe-output-/u);
    expect(path.relative(workspaceDir, observedPath!)).toBe(path.basename(observedPath!));
    expect(path.basename(observedPath!)).toContain("outside.bin");
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });
});
