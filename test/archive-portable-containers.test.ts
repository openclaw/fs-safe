import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry, resolveArchiveKind } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { compressedTarFraming } from "./helpers/archive-tar-framing-compressed.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

describe.each(["off", "auto"] as const)("portable compressed containers mode=%s", (mode) => {
  it.each(["tar-zstd", "tar-bzip2"] as const)("detects, extracts, and reads %s without a platform addon", async (kind) => {
    configureFsSafeNative({ mode });
    const loader = vi.fn(() => { throw new Error("platform addon deliberately omitted"); });
    __setNativeLoaderForTest(loader);
    const root = await tempRoot("fs-safe-portable-container-");
    const archivePath = path.join(root, kind === "tar-zstd" ? "fixture.tar.zst" : "fixture.tar.bz2");
    const destDir = path.join(root, "out");
    await fs.mkdir(destDir);
    await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
    expect(resolveArchiveKind(archivePath)).toBe(kind);
    expect(loader).not.toHaveBeenCalled();
    await extractArchive({ archivePath, destDir, timeoutMs: 10_000 });
    expect(await fs.readFile(path.join(destDir, "value"), "utf8")).toBe("payload");
    expect(await readArchiveEntry(archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
  });

  describe.each(["tar-zstd", "tar-bzip2"] as const)("%s", (kind) => {
    const bytes = Buffer.from(compressedTarFraming[0][kind], "base64");
    it.each([
      ["truncated trailer", bytes.subarray(0, bytes.length - 1)],
      ["trailing garbage", Buffer.concat([bytes, Buffer.from("garbage")])],
      ["incomplete concatenated member", Buffer.concat([bytes, bytes.subarray(0, 3)])],
    ] as const)("rejects %s before filtering, publication, and returning a selected member", async (_name, encoded) => {
      configureFsSafeNative({ mode });
      __setNativeLoaderForTest(() => { throw new Error("platform addon deliberately omitted"); });
      const root = await tempRoot("fs-safe-portable-invalid-container-");
      const archivePath = path.join(root, "fixture.bin");
      const destDir = path.join(root, "out");
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      await fs.writeFile(archivePath, encoded);
      const filter = vi.fn(() => "extract" as const);
      await expect(extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000, entryFilter: filter }))
        .rejects.toMatchObject({ code: "archive-header-invalid" });
      expect(filter).not.toHaveBeenCalled();
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      await expect(readArchiveEntry(archivePath, "value", { kind, maxBytes: 7 }))
        .rejects.toMatchObject({ code: "archive-header-invalid" });
    });
  });
});
