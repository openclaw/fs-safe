import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry, type ArchiveEntryFilter } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { ignoredArchives, ignoredTypes, ignoredIntegrationCases } from "./helpers/archive-ignored.js";
import { tarAdmissionRoutes } from "./helpers/archive-admission-matrix.js";
import { compressedIgnored } from "./helpers/archive-ignored-compressed.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

// Full matrix: A/I/M/V/? × off/tar and require/zstd (all 46 cases per type).
// Route matrix: V/? × the other eight routes, each with all behavior categories:
// order/extract/skip/reject, one alias, omission, strip/count/depth, raw/GNU
// rejection, GNU state clearing + reads, PAX rejection, and one collision.
// All variant combinations remain on the two full routes; hidden-byte discovery
// and admission are exhaustive in archive-tar-ignored-meter.test.ts.
for (const { mode, format, full } of tarAdmissionRoutes) {
  describe.skipIf(mode !== "off" && !paxNative)(`ignored TAR admission ${mode} ${format}`, () => {
    let inspectNative: ReturnType<typeof vi.fn>;
    let extractNative: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode !== "off") {
        const native = paxNative!;
        inspectNative = vi.fn(native.inspectArchiveNative.bind(native));
        extractNative = vi.fn(native.extractArchiveNative.bind(native));
        __setNativeLoaderForTest(() => ({ ...native, inspectArchiveNative: inspectNative, extractArchiveNative: extractNative }));
      }
    });

    async function setup(name: string) {
      const root = await tempRoot("fs-safe-ignored-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      const raw = ignoredArchives[name]!;
      const bytes = format === "tar" ? raw : format === "gzip" ? gzipSync(raw)
        : Buffer.from(compressedIgnored[name]![format]!, "base64");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind: format === "gzip" ? "tar" as const : format, timeoutMs: 10_000 };
    }
    async function unchanged(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      if (mode !== "off") {
        expect(inspectNative).toHaveBeenCalled();
        expect(extractNative).not.toHaveBeenCalled();
      }
    }
    function nativeExecuted() {
      if (mode !== "off") {
        expect(inspectNative).toHaveBeenCalledTimes(1);
        expect(extractNative).toHaveBeenCalledTimes(1);
      }
    }

    describe.each(full ? ignoredTypes : ["V", "?"] as const)("typeflag %s", (type) => {
      const cases = ignoredIntegrationCases(type, full);
      it.each(["extract", "skip-entry", "reject-archive"] as const)("filters exactly once in physical order: %s", async (policy) => {
        const options = await setup(`${type} order`);
        const entryFilter = vi.fn<ArchiveEntryFilter>((entry) => entry.kind === "other" && policy !== "extract" ? "skip" : "extract");
        const extraction = extractArchive({ ...options, entryFilter,
          stripComponents: 1, onFiltered: policy === "skip-entry" ? "skip-entry" : undefined,
          limits: { maxEntries: 4, maxEntryBytes: 4, maxExtractedBytes: 7 },
        });
        if (policy === "reject-archive") {
          await expect(extraction).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-filtered" });
          expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/first", kind: "other", size: 7 }]]);
          await unchanged(options.destDir);
        } else {
          await extraction;
          expect(entryFilter.mock.calls).toEqual([
            [{ path: "pkg/first", kind: "other", size: 7 }], [{ path: "pkg/keep", kind: "file", size: 4 }],
            [{ path: "pkg/last", kind: "other", size: 7 }], [{ path: "pkg/end", kind: "file", size: 3 }],
          ]);
          expect((await fs.readdir(options.destDir)).sort()).toEqual(["end", "keep", "sentinel"]);
          expect(await fs.readFile(path.join(options.destDir, "keep"), "utf8")).toBe("keep");
          nativeExecuted();
        }
      });

      it.each(cases.aliases)("exposes canonical pre-strip identity for %s", async (alias) => {
        const options = await setup(`${type} alias ${alias}`);
        const entryFilter = vi.fn<ArchiveEntryFilter>(({ path }) => path === "pkg/opaque" ? "skip" : "extract");
        await expect(extractArchive({ ...options, stripComponents: 1, entryFilter })).rejects.toMatchObject({ code: "entry-filtered" });
        expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/opaque", kind: "other", size: 7 }]]);
        await unchanged(options.destDir);
      });

      it("omits accepted unsupported records even when the entire archive is ignored", async () => {
        const options = await setup(`${type} all ignored`);
        const entryFilter = vi.fn(() => "extract" as const);
        await extractArchive({ ...options, entryFilter, limits: { maxEntryBytes: 0, maxExtractedBytes: 0 } });
        expect(entryFilter.mock.calls).toEqual([
          [{ path: "one", kind: "other", size: 7 }], [{ path: "two", kind: "other", size: 7 }],
        ]);
        expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
        nativeExecuted();
      });

      it("admits fully stripped records within the entry-count limit", async () => {
        const options = await setup(`${type} stripped`);
        const entryFilter = vi.fn(() => "extract" as const);
        await extractArchive({ ...options, stripComponents: 1, entryFilter, limits: { maxEntries: 2 } });
        expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/keep", kind: "file", size: 4 }]]);
        nativeExecuted();
      });

      it("rejects fully stripped records over the entry-count limit before filtering", async () => {
        const rejected = await setup(`${type} stripped`);
        const entryFilter = vi.fn(() => "extract" as const);
        await expect(extractArchive({ ...rejected, stripComponents: 99, entryFilter, limits: { maxEntries: 1 } }))
          .rejects.toMatchObject({ code: "archive-entry-count-exceeds-limit" });
        expect(entryFilter).not.toHaveBeenCalled();
        await unchanged(rejected.destDir);
      });

      it("rejects excessive path depth before filtering", async () => {
        const deep = await setup(`${type} depth`);
        const entryFilter = vi.fn(() => "extract" as const);
        await expect(extractArchive({ ...deep, entryFilter, onFiltered: "skip-entry", limits: { maxEntryPathComponents: 3 } }))
          .rejects.toMatchObject({ code: "archive-entry-path-components-exceeds-limit" });
        expect(entryFilter).not.toHaveBeenCalled();
        await unchanged(deep.destDir);
      });

      it("admits path depth within the limit after stripping", async () => {
        const deep = await setup(`${type} depth`);
        const entryFilter = vi.fn(() => "extract" as const);
        await extractArchive({ ...deep, stripComponents: 1, entryFilter, limits: { maxEntryPathComponents: 3 } });
        expect(entryFilter.mock.calls[0]).toEqual([{ path: "pkg/a/b/c", kind: "other", size: 7 }]);
      });

      it.each(cases.unsafe)("rejects unsafe %s before any filtering, including fully stripped records", async (name) => {
        const options = await setup(`${type} ${name}`);
        const entryFilter = vi.fn(() => "skip" as const);
        await expect(extractArchive({ ...options, stripComponents: 99, entryFilter, onFiltered: "skip-entry" }))
          .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
        expect(entryFilter).not.toHaveBeenCalled();
        await unchanged(options.destDir);
        if (name === "raw pkg/../bad" || name === "GNU overlong") {
          await expect(readArchiveEntry(options.archivePath, "pkg/keep", { kind: options.kind, maxBytes: 4 }))
            .rejects.toMatchObject({ code: "entry-path" });
        }
      });

      it("admits GNU effective names and clears metadata at the ignored member", async () => {
        const options = await setup(`${type} GNU safe`);
        const entryFilter = vi.fn(() => "extract" as const);
        await extractArchive({ ...options, entryFilter, stripComponents: 1 });
        expect(entryFilter.mock.calls).toEqual([
          [{ path: "pkg/keep", kind: "file", size: 4 }], [{ path: "pkg/effective", kind: "other", size: 7 }],
          [{ path: "pkg/after", kind: "file", size: 5 }],
        ]);
        expect((await fs.readdir(options.destDir)).sort()).toEqual(["after", "keep", "sentinel"]);
        nativeExecuted();
        expect(await readArchiveEntry(options.archivePath, "pkg/after", { kind: options.kind, maxBytes: 5 })).toEqual(Buffer.from("after"));
        await expect(readArchiveEntry(options.archivePath, "pkg//effective", { kind: options.kind, maxBytes: 7 })).rejects.toThrow("not a file");
      });

      it.each(cases.pax)("keeps local PAX on unsupported types fail-closed: %j", async (effective) => {
        const options = await setup(`${type} PAX ${effective}`);
        const entryFilter = vi.fn(() => "skip" as const);
        await expect(extractArchive({ ...options, stripComponents: 99, entryFilter, onFiltered: "skip-entry" }))
          .rejects.toMatchObject({ name: "ArchiveFormatError", code: "archive-header-invalid" });
        expect(entryFilter).not.toHaveBeenCalled();
        await unchanged(options.destDir);
      });

      it.each(cases.collisions)("rejects %s before filtering the second member", async (name) => {
        const options = await setup(name);
        const entryFilter = vi.fn(() => "skip" as const);
        await expect(extractArchive({ ...options, stripComponents: Number(name.at(-1)), entryFilter, onFiltered: "skip-entry" }))
          .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
        expect(entryFilter).toHaveBeenCalledTimes(1);
        await unchanged(options.destDir);
      });
    });
  });
}
