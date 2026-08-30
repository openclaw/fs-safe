import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry, type ArchiveEntryFilter } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { gnuFixture, invalidGnu, validGnu, tarKindFixtures } from "./helpers/archive-gnu.js";
import { compressedGnu } from "./helpers/archive-gnu-compressed.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

for (const mode of ["off", "auto", "require"] as const) {
  const formats = mode === "off" ? ["tar", "gzip"] as const : ["tar", "gzip", "tar-zstd", "tar-bzip2"] as const;
  describe.skipIf(mode !== "off" && !paxNative).each(formats)(`GNU admission and TAR kinds ${mode} %s`, (format) => {
    let extractNative: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode !== "off") {
        const native = paxNative!;
        extractNative = vi.fn(native.extractArchiveNative.bind(native));
        __setNativeLoaderForTest(() => ({ ...native, extractArchiveNative: extractNative }));
      }
    });
    async function setup(bytes: Buffer, name: string) {
      const root = await tempRoot("fs-safe-gnu-policy-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.writeFile(archivePath, format === "gzip" ? gzipSync(bytes) : format === "tar" ? bytes : Buffer.from(compressedGnu[name]![format], "base64"));
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind: format === "gzip" ? "tar" as const : format, timeoutMs: 10_000 };
    }
    async function unchanged(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      if (mode !== "off") expect(extractNative).not.toHaveBeenCalled();
    }

    it.each(invalidGnu)("rejects $name before any filter or publication", async ({ name, entries, code }) => {
      const options = await setup(gnuFixture(entries), name);
      const entryFilter = vi.fn(() => "skip" as const);
      const error = { name: code === "entry-path" ? "ArchiveSecurityError" : "ArchiveFormatError", code };
      for (const stripComponents of [0, 99]) {
        await expect(extractArchive({ ...options, stripComponents, entryFilter, onFiltered: "skip-entry" })).rejects.toMatchObject(error);
      }
      expect(entryFilter).not.toHaveBeenCalled();
      await unchanged(options.destDir);
      await expect(readArchiveEntry(options.archivePath, "keep", { kind: options.kind, maxBytes: 4 })).rejects.toMatchObject(error);
    });

    it.each(validGnu)("admits $name with canonical filter identity and existing link policy", async ({ name, entries, paths, kind, size }) => {
      const options = await setup(gnuFixture(entries), name);
      const entryFilter = vi.fn<ArchiveEntryFilter>((entry) => entry.kind === "symlink" ? "skip" : "extract");
      await extractArchive({ ...options, entryFilter, onFiltered: "skip-entry", limits: { maxEntries: 1 + paths.length } });
      expect(entryFilter.mock.calls).toEqual([
        [{ path: "keep", kind: "file", size: 4 }], ...paths.map((path) => [{ path, kind, size }]),
      ]);
      expect(await fs.readFile(path.join(options.destDir, "keep"), "utf8")).toBe("keep");
      if (mode !== "off") expect(extractNative).toHaveBeenCalledTimes(1);
      for (const name of paths) {
        if (kind === "file") expect(await fs.readFile(path.join(options.destDir, name), "utf8")).toBe("value");
        else await expect(fs.lstat(path.join(options.destDir, name))).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (kind === "symlink") {
        const rejected = await setup(gnuFixture(entries), name);
        await expect(extractArchive(rejected)).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-link" });
        expect(await fs.readdir(rejected.destDir)).toEqual(["sentinel"]);
      }
    });

    it.each(["L", "K"] as const)("bounds %s bodies before buffering", async (type) => {
      const fixture = invalidGnu.find(({ name }) => name === `${type} embedded NUL suffix`)!;
      const options = await setup(gnuFixture(fixture.entries), fixture.name);
      const entryFilter = vi.fn(() => "skip" as const);
      await expect(extractArchive({ ...options, entryFilter, limits: { maxMetaEntryBytes: 9 } }))
        .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-meta-entry-size-exceeds-limit" });
      expect(entryFilter).not.toHaveBeenCalled();
      await unchanged(options.destDir);
    });

    it.each(tarKindFixtures)("applies filter policy to $name", async ({ name, entries }) => {
      const directory = name.startsWith("GNUDumpDir");
      const size = name === "GNUDumpDir payload" ? 6 : 0;
      for (const policy of ["default", "extract", "reject-filtered", "skip"] as const) {
        const options = await setup(gnuFixture(entries), name);
        const entryFilter = vi.fn<ArchiveEntryFilter>((entry) => entry.path === (directory ? "pkg/directory" : "pkg/special") && (policy === "skip" || policy === "reject-filtered") ? "skip" : "extract");
        const extraction = extractArchive({ ...options,
          entryFilter: policy === "default" ? undefined : entryFilter,
          onFiltered: policy === "skip" ? "skip-entry" : undefined,
          limits: policy === "skip" ? { maxEntryBytes: 4, maxExtractedBytes: 4 } : undefined,
        });
        if (policy === "skip" || (directory && policy !== "reject-filtered")) {
          await extraction;
          if (directory && policy !== "skip") expect((await fs.stat(path.join(options.destDir, "pkg", "directory"))).isDirectory()).toBe(true);
          else expect(await fs.readdir(options.destDir)).toEqual(["keep", "sentinel"]);
          expect(await fs.readFile(path.join(options.destDir, "keep"), "utf8")).toBe("keep");
          if (mode !== "off") expect(extractNative).toHaveBeenCalledTimes(1);
        } else {
          await expect(extraction).rejects.toMatchObject({ name: "ArchiveSecurityError", code: policy === "reject-filtered" ? "entry-filtered" : "entry-link" });
          await unchanged(options.destDir);
        }
        if (policy !== "default") expect(entryFilter.mock.calls).toEqual([
          [{ path: "keep", kind: "file", size: 4 }],
          [{ path: directory ? "pkg/directory" : "pkg/special", kind: directory ? "directory" : "other", size }],
        ]);
        vi.clearAllMocks();
      }
      if (size) {
        const options = await setup(gnuFixture(entries), name);
        await expect(extractArchive({ ...options, limits: { maxEntryBytes: 4 } }))
          .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-entry-extracted-size-exceeds-limit" });
        await unchanged(options.destDir);
      }
    });
  });
}
