import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTarEntryPreflightChecker, extractArchive, type ArchiveEntryFilter } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture, type TarFixtureEntry } from "./helpers/archive-fuzz.js";
import { paxHeader } from "./helpers/archive-pax.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { unicodePath, zipRecords } from "./helpers/zip-records.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const aliases = [
  "pkg\\state\\cache\\value",
  "./pkg/state/./cache/value",
  "pkg//state///cache//value",
  ".\\pkg//state\\.\\cache//value",
];
const securityError = (code: string) => ({ name: "ArchiveSecurityError", code });

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`canonical archive filter paths (${mode})`, () => {
    let inspectNative: ReturnType<typeof vi.fn>;
    let extractNative: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") {
        const native = paxNative!;
        inspectNative = vi.fn(native.inspectArchiveNative.bind(native));
        extractNative = vi.fn(native.extractArchiveNative.bind(native));
        __setNativeLoaderForTest(() => ({
          ...native, inspectArchiveNative: inspectNative, extractArchiveNative: extractNative,
        }));
      }
    });

    async function setup(bytes: Buffer, kind: "zip" | "tar") {
      const root = await tempRoot("fs-safe-filter-paths-");
      const archivePath = path.join(root, `fixture.${kind}`);
      const destDir = path.join(root, "out");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind, timeoutMs: 10_000 };
    }

    async function unchanged(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
      if (mode === "require") expect(extractNative).not.toHaveBeenCalled();
    }

    function nativeExecuted() {
      if (mode === "require") {
        expect(inspectNative).toHaveBeenCalledTimes(1);
        expect(extractNative).toHaveBeenCalledTimes(1);
      }
    }

    for (const format of ["zip", "tar", "gzip"] as const) {
      describe(format, () => {
        function fixture(entries: TarFixtureEntry[]) {
          if (format === "zip") {
            return setup(zipRecords(entries.map((entry) => ({
              name: entry.path,
              body: String(entry.body ?? ""),
              attributes: entry.type === "5" ? 0x41ed0010 : undefined,
            }))), "zip");
          }
          const bytes = tarFixture(entries);
          return setup(format === "gzip" ? gzipSync(bytes) : bytes, "tar");
        }

        it.each(aliases)("blocks excluded subtree alias %s before and after stripping", async (alias) => {
          for (const stripComponents of [0, 1]) {
            for (const onFiltered of [undefined, "skip-entry"] as const) {
              const options = await fixture([
                { path: "./pkg//keep", body: "keep" },
                { path: alias, body: "secret" },
              ]);
              const entryFilter = vi.fn<ArchiveEntryFilter>((entry) =>
                entry.path.startsWith("pkg/state/cache/") ? "skip" : "extract",
              );
              const extraction = extractArchive({
                ...options, stripComponents, entryFilter, onFiltered,
                limits: { maxEntryBytes: 4, maxExtractedBytes: 4 },
              });
              if (onFiltered === "skip-entry") {
                await extraction;
                const keep = stripComponents ? "keep" : "pkg/keep";
                expect(await fs.readFile(path.join(options.destDir, keep), "utf8")).toBe("keep");
                expect((await fs.readdir(options.destDir, { recursive: true })).sort()).toEqual(
                  (stripComponents ? ["keep", "sentinel"] : ["pkg", "sentinel", path.join("pkg", "keep")]).sort(),
                );
                nativeExecuted();
              } else {
                await expect(extraction).rejects.toMatchObject(securityError("entry-filtered"));
                await unchanged(options.destDir);
              }
              expect(entryFilter.mock.calls).toEqual([
                [{ path: "pkg/keep", kind: "file", size: 4 }],
                [{ path: "pkg/state/cache/value", kind: "file", size: 6 }],
              ]);
              vi.clearAllMocks();
            }
          }
        });

        it.each(aliases)("uses the filter identity to extract and strip %s", async (alias) => {
          for (const stripComponents of [0, 1, 3]) {
            const options = await fixture([{ path: alias, body: "value" }]);
            const entryFilter = vi.fn<ArchiveEntryFilter>((entry) =>
              entry.path === "pkg/state/cache/value" ? "extract" : "skip",
            );
            await extractArchive({ ...options, stripComponents, entryFilter });
            const output = ["pkg", "state", "cache", "value"].slice(stripComponents).join("/");
            expect(await fs.readFile(path.join(options.destDir, output), "utf8")).toBe("value");
            expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/state/cache/value", kind: "file", size: 5 }]]);
            nativeExecuted();
            vi.clearAllMocks();
          }
        });

        it("gives exact-string filters canonical directory and file paths before stripping", async () => {
          const options = await fixture([
            { path: "./pkg//state\\cache/", type: "5" },
            { path: "pkg\\state//cache/./value", body: "secret" },
            { path: "./pkg//keep", body: "keep" },
          ]);
          const entryFilter = vi.fn<ArchiveEntryFilter>((entry) =>
            entry.path === "pkg/state/cache" || entry.path === "pkg/state/cache/value" ? "skip" : "extract",
          );
          await extractArchive({ ...options, stripComponents: 1, entryFilter, onFiltered: "skip-entry" });
          expect(entryFilter.mock.calls).toEqual([
            [{ path: "pkg/state/cache", kind: "directory", size: 0 }],
            [{ path: "pkg/state/cache/value", kind: "file", size: 6 }],
            [{ path: "pkg/keep", kind: "file", size: 4 }],
          ]);
          expect(await fs.readdir(options.destDir)).toEqual(["keep", "sentinel"]);
          nativeExecuted();
        });

        it.each([
          ...aliases.map((alias) => ["pkg/state/cache/value", alias, 0] as const),
          ["pkg/state/cache/value", "PKG//STATE/./CACHE\\VALUE", 0] as const,
          ["pkg/state/cache/value", "other//state/./cache\\value", 1] as const,
        ])("rejects colliding identities %s and %s (strip=%s) even when filtered", async (first, second, stripComponents) => {
          const options = await fixture([{ path: first, body: "one" }, { path: second, body: "two" }]);
          await expect(extractArchive({
            ...options, stripComponents, entryFilter: () => "skip", onFiltered: "skip-entry",
          })).rejects.toMatchObject(securityError("entry-path"));
          await unchanged(options.destDir);
        });

        it.each([
          "../value", "pkg/../value", "pkg\\..\\value", "/pkg/value", "\\pkg\\value",
          "C:value", "pkg/C:value", "./C:/value",
          ...(format === "zip" ? ["pkg/val\0ue"] : []),
        ])("validates unsafe raw path %j before normalization, stripping or filtering", async (raw) => {
          const options = await fixture([{ path: raw, body: "bad" }]);
          const entryFilter = vi.fn(() => "skip" as const);
          await expect(extractArchive({ ...options, stripComponents: 99, entryFilter, onFiltered: "skip-entry" }))
            .rejects.toMatchObject(securityError("entry-path"));
          expect(entryFilter).not.toHaveBeenCalled();
          await unchanged(options.destDir);
        });

        it("counts fully stripped physical entries without invoking their filters", async () => {
          const options = await fixture([
            { path: "./pkg//", type: "5" },
            { path: "./discarded", body: "discarded" },
            { path: "./pkg//keep", body: "keep" },
          ]);
          const entryFilter = vi.fn(() => "extract" as const);
          await extractArchive({ ...options, stripComponents: 1, entryFilter, limits: { maxEntries: 3 } });
          expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/keep", kind: "file", size: 4 }]]);
          expect(await fs.readFile(path.join(options.destDir, "keep"), "utf8")).toBe("keep");
          nativeExecuted();

          await expect(extractArchive({ ...options, stripComponents: 99, limits: { maxEntries: 2 } }))
            .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-entry-count-exceeds-limit" });
        });

        if (format !== "zip") {
          it.each(["PAX", "GNU"])("filters canonical effective %s paths", async (extension) => {
            const effective = ".\\pkg//state/./cache\\value";
            const metadata = extension === "PAX"
              ? paxHeader([["path", effective]])
              : { path: "././@LongLink", type: "L", body: `${effective}\0` };
            const options = await fixture([metadata, { path: "innocent", body: "secret" }]);
            const entryFilter = vi.fn<ArchiveEntryFilter>((entry) =>
              entry.path === "pkg/state/cache/value" ? "skip" : "extract",
            );
            await extractArchive({ ...options, stripComponents: 1, entryFilter, onFiltered: "skip-entry" });
            expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/state/cache/value", kind: "file", size: 6 }]]);
            expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
            nativeExecuted();
          });
        }
      });
    }

    it("filters canonical ZIP Unicode Path names without changing Unicode spelling", async () => {
      const options = await setup(zipRecords([{
        name: "legacy", body: "secret",
        extra: unicodePath(Buffer.from("legacy"), "./pkg//state\\cache/caf\u00e9"),
      }]), "zip");
      const entryFilter = vi.fn<ArchiveEntryFilter>((entry) =>
        entry.path === "pkg/state/cache/caf\u00e9" ? "skip" : "extract",
      );
      await extractArchive({ ...options, stripComponents: 1, entryFilter, onFiltered: "skip-entry" });
      expect(entryFilter.mock.calls).toEqual([[{ path: "pkg/state/cache/caf\u00e9", kind: "file", size: 6 }]]);
      expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
      nativeExecuted();
    });
  });
}

it("rejects NUL in a raw TAR policy path before stripping or filtering", () => {
  const entryFilter = vi.fn(() => "skip" as const);
  const check = createTarEntryPreflightChecker({ rootDir: process.cwd(), stripComponents: 99, entryFilter });
  expect(() => check({ path: "pkg/val\0ue", type: "File", size: 0 })).toThrow(
    expect.objectContaining(securityError("entry-path")),
  );
  expect(entryFilter).not.toHaveBeenCalled();
});
