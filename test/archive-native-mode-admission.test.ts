import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { modeArchive } from "./helpers/archive-modes.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.skipIf(!native)("native ZIP permission metadata association", () => {
  it.each(["index", "path", "size", "mode"] as const)("rejects mocked %s disagreement before filters or extraction", async (field) => {
    const base = await tempRoot("fs-safe-native-mode-admission-");
    const archivePath = path.join(base, "fixture.zip");
    const destDir = path.join(base, "output");
    await fs.mkdir(destDir);
    await fs.writeFile(archivePath, await modeArchive("zip", [{ path: "zero", mode: 0 }]));
    const extract = vi.fn(native!.extractArchiveNative);
    __setNativeLoaderForTest(() => ({
      ...native!,
      async inspectArchiveNative(...args: Parameters<NativeBinding["inspectArchiveNative"]>) {
        const manifest = await native!.inspectArchiveNative(...args);
        const entry = manifest[0]!;
        if (field === "path") entry.path = "different";
        else entry[field]++;
        return manifest;
      },
      extractArchiveNative: extract,
    }));
    configureFsSafeNative({ mode: "require" });
    const filter = vi.fn(() => "extract" as const);
    await expect(extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 10000, entryModes: "preserve", entryFilter: filter }))
      .rejects.toMatchObject({ code: "archive-header-invalid" });
    expect(filter).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(await fs.readdir(destDir)).toEqual([]);
  });
});
