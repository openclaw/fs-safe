import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry, type ArchiveEntryFilter } from "../src/archive.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { admissionCases, linknameCases, manifestArchive, manifestMember, routeAdmissionCases, routeLinknameCases } from "./helpers/archive-admission.js";
import { tarAdmissionRoutes } from "./helpers/archive-admission-matrix.js";
import { compressedAdmission } from "./helpers/archive-admission-compressed.js";
import { gnuFixture, invalidGnu, validGnu, tarKindFixtures } from "./helpers/archive-gnu.js";
import { compressedGnu } from "./helpers/archive-gnu-compressed.js";
import { ignoredArchives, ignoredTypes, ignoredIntegrationCases } from "./helpers/archive-ignored.js";
import { compressedIgnored } from "./helpers/archive-ignored-compressed.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

for (const { mode, format, full } of tarAdmissionRoutes) {
  describe.skipIf(mode !== "off" && !paxNative)(`TAR admission ${mode} ${format}`, () => {
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
    async function createFixture(name: string, raw: () => Buffer, compressed: Record<string, Partial<Record<"tar-zstd" | "tar-bzip2", string>>>) {
      const root = await tempRoot("fs-safe-admission-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      const bytes = format === "tar" ? raw() : format === "gzip" ? gzipSync(raw())
        : Buffer.from(compressed[name]![format]!, "base64");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind: format === "gzip" ? "tar" as const : format, timeoutMs: 10_000 };
    }
    async function sentinelUnchanged(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
    }

    // All header variants run on off/tar and require/zstd. Each other route keeps
    // checksum, strict fixed fields (including metadata replacement), normalization,
    // GNU file/directory/D semantics, forbidden/required/valid linknames, and budget
    // checks. Explicit fixture lists avoid repeating every type/field/replacement
    // combination ten times. GNU/PAX budgets both run on the full routes; other
    // routes alternate them by mode (auto=PAX, off/require=GNU).
    describe("raw admission", () => {
      function setup(name: string, raw: () => Buffer) {
        return createFixture(name, raw, compressedAdmission);
      }
      async function unchanged(destDir: string) {
        await sentinelUnchanged(destDir);
        if (mode !== "off") {
          expect(inspectNative).toHaveBeenCalledTimes(1);
          expect(extractNative).not.toHaveBeenCalled();
        }
      }

      it.each((full ? Object.keys(admissionCases) : routeAdmissionCases).map((name) => [name, admissionCases[name]!] as const))("admits %s before policy", async (name, fixture) => {
        const options = await setup(name, () => fixture.bytes);
        const entryFilter = vi.fn(() => "extract" as const);
        if (fixture.code) {
          await expect(extractArchive({ ...options, entryFilter, stripComponents: 99, onFiltered: "skip-entry" }))
            .rejects.toMatchObject({ name: fixture.code === "entry-path" ? "ArchiveSecurityError" : "ArchiveFormatError", code: fixture.code });
          expect(entryFilter).not.toHaveBeenCalled();
          await unchanged(options.destDir);
          await expect(readArchiveEntry(options.archivePath, "keep", { kind: options.kind, maxBytes: 4 }))
            .rejects.toMatchObject({ code: fixture.code });
        } else {
          await extractArchive({ ...options, entryFilter });
          expect(entryFilter.mock.calls).toEqual([
            [{ path: "keep", kind: "file", size: 4 }], [{ path: "pkg/directory", kind: "directory", size: 0 }],
          ]);
          expect((await fs.stat(path.join(options.destDir, "pkg/directory"))).isDirectory()).toBe(true);
          expect(await fs.readFile(path.join(options.destDir, "keep"), "utf8")).toBe("keep");
          if (mode !== "off") expect(extractNative).toHaveBeenCalledTimes(1);
        }
      });

      it.each((full ? Object.keys(linknameCases) : routeLinknameCases).map((name) => [name, linknameCases[name]!] as const))("validates raw linkname policy: %s", async (name, fixture) => {
        const options = await setup(name, () => fixture.bytes);
        const entryFilter = vi.fn(() => "skip" as const);
        const extraction = extractArchive({ ...options, entryFilter, onFiltered: "skip-entry" });
        if (fixture.code) {
          const error = { name: fixture.code === "entry-path" ? "ArchiveSecurityError" : "ArchiveFormatError", code: fixture.code };
          await expect(extraction).rejects.toMatchObject(error);
          expect(entryFilter).not.toHaveBeenCalled();
          await unchanged(options.destDir);
          await expect(readArchiveEntry(options.archivePath, "keep", { kind: options.kind, maxBytes: 4 })).rejects.toMatchObject(error);
        } else {
          await extraction;
          expect(entryFilter.mock.calls).toEqual([
            [{ path: "keep", kind: "file", size: 4 }], [{ path: "member", kind: fixture.kind, size: 0 }],
          ]);
          if (mode !== "off") {
            expect(inspectNative).toHaveBeenCalledTimes(1);
            expect(extractNative).toHaveBeenCalledTimes(1);
          }
          await expect(readArchiveEntry(options.archivePath, "keep", { kind: options.kind, maxBytes: 4 })).resolves.toEqual(Buffer.from("keep"));
        }
        expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
        expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
      });

      it.each(full ? ["GNU", "PAX"] as const : [mode === "auto" ? "PAX" : "GNU"] as const)("bounds retained near-limit %s paths before policy", async (extension) => {
        const options = await setup(`${extension} manifest`, () => manifestArchive(extension));
        const entryFilter = vi.fn(() => "skip" as const);
        await expect(extractArchive({ ...options, entryFilter, onFiltered: "skip-entry", stripComponents: 99_999 }))
          .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-manifest-size-exceeds-limit" });
        expect(entryFilter).not.toHaveBeenCalled();
        await unchanged(options.destDir);
        await expect(readArchiveEntry(options.archivePath, "absent", { kind: options.kind, maxBytes: 0 }))
          .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-manifest-size-exceeds-limit" });
      }, 30_000);

      it("keeps the manifest budget independent of compressed file size", async () => {
        const name = Array<string>(16).fill("a".repeat(255)).join("/");
        const options = await setup("small compressed manifest", () => Buffer.concat([manifestMember("GNU", name), Buffer.alloc(1024)]));
        const entryFilter = vi.fn(() => "skip" as const);
        await extractArchive({ ...options, entryFilter, onFiltered: "skip-entry", limits: { maxEntries: 1, maxArchiveBytes: (await fs.stat(options.archivePath)).size } });
        expect(entryFilter).toHaveBeenCalledTimes(1);
        expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
        if (mode !== "off") expect(extractNative).toHaveBeenCalledTimes(1);
      });
    });

    describe("GNU admission and TAR kinds", () => {
      function setup(bytes: Buffer, name: string) {
        return createFixture(name, () => bytes, compressedGnu);
      }
      async function unchanged(destDir: string) {
        await sentinelUnchanged(destDir);
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

      it.each(tarKindFixtures.flatMap((fixture) =>
        (["default", "extract", "reject-filtered", "skip"] as const).map((policy) => ({ ...fixture, policy })),
      ))("applies $policy filter policy to $name", async ({ name, entries, policy }) => {
        const directory = name.startsWith("GNUDumpDir");
        const size = name === "GNUDumpDir payload" ? 6 : 0;
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
          else expect((await fs.readdir(options.destDir)).sort()).toEqual(["keep", "sentinel"]);
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
      });

      it.each(tarKindFixtures.filter(({ name }) => name === "GNUDumpDir payload"))("bounds the payload of $name", async ({ name, entries }) => {
        const options = await setup(gnuFixture(entries), name);
        await expect(extractArchive({ ...options, limits: { maxEntryBytes: 4 } }))
          .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-entry-extracted-size-exceeds-limit" });
        await unchanged(options.destDir);
      });
    });

    // Full matrix: A/I/M/V/? × off/tar and require/zstd (all 46 cases per type).
    // Route matrix: V/? × the other eight routes, each with all behavior categories:
    // order/extract/skip/reject, one alias, omission, strip/count/depth, raw/GNU
    // rejection, GNU state clearing + reads, PAX rejection, and one collision.
    // All variant combinations remain on the two full routes; hidden-byte discovery
    // and admission are exhaustive in archive-tar-ignored-meter.test.ts.
    describe("ignored members", () => {
      function setup(name: string) {
        return createFixture(name, () => ignoredArchives[name]!, compressedIgnored);
      }
      async function unchanged(destDir: string) {
        await sentinelUnchanged(destDir);
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
  });
}
