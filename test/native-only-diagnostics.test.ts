import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry, resolveArchiveKind } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { compressedTarFraming } from "./helpers/archive-tar-framing-compressed.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "auto"] as const) {
  describe(`compressed archive fallback with mode ${mode}`, () => {
    it.each(["tar-zstd", "tar-bzip2"] as const)("detects, extracts, and reads %s with the platform package absent", async (kind) => {
      configureFsSafeNative({ mode });
      const loader = vi.fn(() => { throw new Error("platform package omitted"); });
      __setNativeLoaderForTest(loader);
      const root = await tempRoot("fs-safe-native-diagnostics-");
      const archivePath = path.join(root, kind === "tar-zstd" ? "fixture.tar.zst" : "fixture.tar.bz2");
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
      expect(resolveArchiveKind(archivePath)).toBe(kind);
      await extractArchive({ archivePath, destDir, timeoutMs: 10_000 });
      await expect(fs.readFile(path.join(destDir, "value"), "utf8")).resolves.toBe("payload");
      await expect(readArchiveEntry(archivePath, "value", { maxBytes: 7 })).resolves.toEqual(Buffer.from("payload"));
      expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    });
  });
}

it.each(["tar-zstd", "tar-bzip2"] as const)("retains the missing native cause for required %s operations", async (kind) => {
  configureFsSafeNative({ mode: "require" });
  const cause = new Error("platform package omitted");
  __setNativeLoaderForTest(() => { throw cause; });
  const root = await tempRoot("fs-safe-required-archive-");
  const archivePath = path.join(root, kind === "tar-zstd" ? "fixture.tar.zst" : "fixture.tar.bz2");
  const destDir = path.join(root, "destination");
  await fs.mkdir(destDir);
  await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
  const expected = { name: "FsSafeError", code: "helper-unavailable", cause };
  expect(() => resolveArchiveKind(archivePath)).toThrow(expect.objectContaining(expected));
  await expect(extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000 })).rejects.toMatchObject(expected);
  await expect(readArchiveEntry(archivePath, "value", { maxBytes: 7, kind })).rejects.toMatchObject(expected);
  expect(await fs.readdir(destDir)).toEqual([]);
});

it("reports unsupported private-directory platforms without suggesting an install", async () => {
  await expect(createPrivateDirectory("unused", { platform: "linux" })).rejects.toMatchObject({
    code: "helper-unavailable",
    message: "private-directory creation is supported only on Windows",
  });
});
