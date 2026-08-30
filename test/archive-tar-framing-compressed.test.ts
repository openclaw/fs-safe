import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { compressedTarFraming } from "./helpers/archive-tar-framing-compressed.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { resolveExtractLimits, resolveTarMeterLimits } from "../src/archive-limits.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.each(["auto", "require"] as const)("compressed TAR framing mode=%s", (mode) => {
  describe.skipIf(!paxNative).each(["tar-zstd", "tar-bzip2"] as const)("%s", (kind) => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      __setNativeLoaderForTest(() => paxNative!);
    });

    it.each([
      [{ maxEntries: 2 }, "archive-entry-count-exceeds-limit"],
      [{ maxEntries: 0 }, "archive-entry-count-exceeds-limit"],
      [{ maxEntryBytes: 6 }, "archive-entry-extracted-size-exceeds-limit"],
      [{ maxExtractedBytes: 9 }, "archive-extracted-size-exceeds-limit"],
      [{ maxArchiveBytes: 2048, maxExtractedBytes: 10 }, "archive-decoded-size-exceeds-limit"],
    ] as const)("enforces %j in admission and later native passes", async (overrides, code) => {
      const root = await tempRoot("fs-safe-tar-compressed-budget-");
      const archivePath = path.join(root, "fixture.bin");
      const destDir = path.join(root, "out");
      await fs.mkdir(destDir);
      await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
      const entryFilter = vi.fn(() => "skip" as const);
      const limits = resolveExtractLimits(overrides);
      await expect(extractArchive({ archivePath, destDir, kind, limits, timeoutMs: 10_000, entryFilter, onFiltered: "skip-entry" }))
        .rejects.toMatchObject({ name: "ArchiveLimitError", code });
      expect(entryFilter).not.toHaveBeenCalled();
      const directory = await fs.open(destDir, "r");
      try {
        await expect(paxNative!.extractArchiveNative(archivePath, kind, directory.fd, [], resolveTarMeterLimits(limits), new AbortController().signal)).rejects.toThrow(code);
        await expect(paxNative!.readArchiveEntryNative(archivePath, kind, "absent", 7, resolveTarMeterLimits(limits), new AbortController().signal)).rejects.toThrow(code);
      } finally {
        await directory.close();
      }
      expect(await fs.readdir(destDir)).toEqual([]);
    });

    it("reads a small compressed member despite larger unrelated members", async () => {
      const root = await tempRoot("fs-safe-tar-compressed-read-budget-");
      const archivePath = path.join(root, "fixture.bin");
      await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
      const requested = "directory/" + "x".repeat(120);
      expect(await readArchiveEntry(archivePath, requested, { kind, maxBytes: 3 })).toEqual(Buffer.from("gnu"));
      expect(await paxNative!.readArchiveEntryNative(archivePath, kind, requested, 3, resolveTarMeterLimits(), new AbortController().signal)).toEqual(Buffer.from("gnu"));
      await expect(readArchiveEntry(archivePath, requested, { kind, maxBytes: 2 })).rejects.toMatchObject({
        name: "ArchiveLimitError", code: "archive-entry-extracted-size-exceeds-limit",
      });
    });

    it.each(compressedTarFraming)("$name", async (fixture) => {
      const root = await tempRoot("fs-safe-tar-framing-compressed-");
      const archivePath = path.join(root, "fixture.bin");
      const destDir = path.join(root, "out");
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      await fs.writeFile(archivePath, Buffer.from(fixture[kind], "base64"));
      const entryFilter = vi.fn(() => "extract" as const);
      const extract = extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000, entryFilter });
      if (fixture.accepted) {
        await extract;
        expect(await fs.readFile(path.join(destDir, "value"), "utf8")).toBe("payload");
        expect(await fs.readFile(path.join(destDir, "directory", "x".repeat(120)), "utf8")).toBe("gnu");
        expect(await readArchiveEntry(archivePath, "value", { kind, maxBytes: 7 })).toEqual(Buffer.from("payload"));
      } else {
        const invalid = { name: "ArchiveFormatError", code: "archive-header-invalid" };
        await expect(extract).rejects.toMatchObject(invalid);
        expect(entryFilter).not.toHaveBeenCalled();
        expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
        await expect(readArchiveEntry(archivePath, "value", { kind, maxBytes: 7 })).rejects.toMatchObject(invalid);
      }
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
    });
  });
});

it.each(["off", "auto", "require"] as const)("keeps unavailable native codec policy in mode=%s", async (mode) => {
  configureFsSafeNative({ mode });
  __setNativeLoaderForTest(() => { throw new Error("fixture: native unavailable"); });
  const root = await tempRoot("fs-safe-tar-framing-unavailable-");
  const archivePath = path.join(root, "fixture.bin");
  const destDir = path.join(root, "out");
  await fs.mkdir(destDir);
  for (const kind of ["tar-zstd", "tar-bzip2"] as const) {
    await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
    await expect(extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000 })).rejects.toMatchObject({ code: "helper-unavailable" });
    await expect(readArchiveEntry(archivePath, "value", { kind, maxBytes: 7 })).rejects.toMatchObject({ code: "helper-unavailable" });
  }
});
