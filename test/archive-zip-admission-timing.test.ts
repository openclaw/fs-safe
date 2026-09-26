import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight } from "../src/archive.js";
import * as admission from "../src/archive-zip-admission.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { zipRecords } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it("reports synchronous public preflight validation failure through its returned promise", async () => {
  const failure = new Error("preflight limit getter failed");
  let operation: ReturnType<typeof loadZipArchiveWithPreflight> | undefined;
  expect(() => {
    operation = loadZipArchiveWithPreflight(zipRecords([]), {
      get maxArchiveBytes() { throw failure; },
    });
  }).not.toThrow();
  await expect(operation).rejects.toBe(failure);
});

it.each([false, true])("preserves ZIP preflight failure versus elapsed deadline precedence (expired=%s)", async expired => {
  const root = await tempRoot("fs-safe-zip-admission-timing-");
  const archivePath = path.join(root, "input.zip"), destDir = path.join(root, "output");
  await fs.writeFile(archivePath, zipRecords([{ name: "value" }]));
  await fs.mkdir(destDir);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const failure = new Error("synchronous ZIP admission failed");
  const scan = vi.spyOn(admission, "admitZipBuffer").mockImplementation(() => {
    if (expired) now = 60_000;
    throw failure;
  });
  const operation = extractArchive({ archivePath, destDir, timeoutMs: 60_000 });
  if (expired) await expect(operation).rejects.toThrow("extract zip timed out after 60000ms");
  else await expect(operation).rejects.toBe(failure);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(destDir)).toEqual([]);
});
