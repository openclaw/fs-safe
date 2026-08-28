import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, type ExtractArchiveOptions } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture, type TarFixtureEntry } from "./helpers/archive-fuzz.js";
import { paxHeader } from "./helpers/archive-pax.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`TAR stripping mode=${mode}`, () => {
    let extractNative: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") {
        const native = paxNative!;
        extractNative = vi.fn(native.extractArchiveNative.bind(native));
        __setNativeLoaderForTest(() => ({ ...native, extractArchiveNative: extractNative }));
      }
    });

    async function setup(entries: TarFixtureEntry[], gzip = false) {
      const root = await tempRoot("fs-safe-tar-strip-");
      const archivePath = path.join(root, gzip ? "fixture.tar.gz" : "fixture.tar");
      const destDir = path.join(root, "out");
      const bytes = tarFixture(entries);
      await fs.writeFile(archivePath, gzip ? gzipSync(bytes) : bytes);
      await fs.mkdir(destDir);
      return { archivePath, destDir, timeoutMs: 10_000 };
    }

    async function expectOutput(destDir: string, name: string, bytes: string, expectedMode: number) {
      expect(await fs.readdir(destDir, { recursive: true })).toEqual([name]);
      expect(await fs.readFile(path.join(destDir, name))).toEqual(Buffer.from(bytes));
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(destDir, name))).mode & 0o7777).toBe(expectedMode);
      }
      if (mode === "require") {
        // Native cases must execute the real binding, not merely select require mode.
        expect(extractNative).toHaveBeenCalledTimes(1);
      }
    }

    it.each([
      { pax: false, gzip: false },
      { pax: false, gzip: true },
      { pax: true, gzip: false },
      { pax: true, gzip: true },
    ])("writes the validated dot-prefixed path and mode (PAX=$pax, gzip=$gzip)", async ({ pax, gzip }) => {
      const entryPath = "./pkg/hello.txt";
      const fixture = await setup([
        { path: "./", type: "5" },
        { path: "./pkg/", type: "5" },
        { path: "./discarded", body: "fully stripped file" },
        ...(pax ? [paxHeader([["path", entryPath]])] : []),
        { path: pax ? "raw-name" : entryPath, body: "hi", mode: 0o7755 },
      ], gzip);
      const entryFilter = vi.fn(() => "extract" as const);

      await extractArchive({
        ...fixture,
        stripComponents: 1,
        entryFilter,
        limits: { maxEntryPathComponents: 1 },
      });

      expect(entryFilter.mock.calls).toEqual([[{ path: entryPath, kind: "file", size: 2 }]]);
      await expectOutput(fixture.destDir, "hello.txt", "hi", 0o755);
    });

    it.each([
      { entryPath: "package/hello.txt", strip: 1 },
      { entryPath: "pkg//./nested/hello.txt", strip: 2 },
      { entryPath: "./hello.txt", strip: 0 },
    ])("preserves ordinary and normalized paths: $entryPath, strip=$strip", async ({ entryPath, strip }) => {
      const fixture = await setup([{ path: entryPath, body: "preserved", mode: 0o7764 }]);
      const entryFilter = vi.fn(() => "extract" as const);
      await extractArchive({ ...fixture, stripComponents: strip, entryModes: "preserve", entryFilter });

      expect(entryFilter.mock.calls).toEqual([[{ path: entryPath, kind: "file", size: 9 }]]);
      await expectOutput(fixture.destDir, "hello.txt", "preserved", 0o764);
    });

    it.each([
      {
        name: "collision after normalization and stripping",
        entries: [
          paxHeader([["path", "./pkg/hello.txt"]]), { path: "raw", body: "first" },
          { path: "other//./hello.txt", body: "second" },
        ],
        code: "entry-path",
      },
      {
        name: "output depth after stripping",
        entries: [paxHeader([["path", "./pkg/deep/hello.txt"]]), { path: "raw", body: "hi" }],
        code: "archive-entry-path-components-exceeds-limit",
      },
      {
        name: "traversal before stripping",
        entries: [paxHeader([["path", "../hello.txt"]]), { path: "raw", body: "hi" }],
        code: "entry-path",
      },
      ...["1", "2"].map((type) => ({
        name: `blocked link type=${type}`,
        entries: [
          paxHeader([["path", "./pkg/link"]]),
          { path: "raw", type, linkPath: "target" },
        ],
        code: "entry-link",
      })),
    ])("rejects $name without publishing a tree", async ({ entries, code }) => {
      const fixture = await setup(entries);
      await expect(extractArchive({
        ...fixture,
        stripComponents: 1,
        limits: { maxEntryPathComponents: 1 },
      })).rejects.toMatchObject({ code });
      expect(await fs.readdir(fixture.destDir)).toEqual([]);
      if (mode === "require") expect(extractNative).not.toHaveBeenCalled();
    });

    it.each([undefined, "skip-entry"] as const)("keeps pre-strip link filter policy (onFiltered=%s)", async (onFiltered) => {
      const fixture = await setup([
        paxHeader([["path", "./pkg/link"]]),
        { path: "raw", type: "2", linkPath: "target" },
        { path: "pkg/hello.txt", body: "hi", mode: 0o755 },
      ]);
      const entryFilter = vi.fn<NonNullable<ExtractArchiveOptions["entryFilter"]>>(
        (entry) => entry.path === "./pkg/link" ? "skip" : "extract",
      );
      const extraction = extractArchive({ ...fixture, stripComponents: 1, entryFilter, onFiltered });
      if (onFiltered === "skip-entry") {
        await extraction;
        await expectOutput(fixture.destDir, "hello.txt", "hi", 0o755);
        expect(entryFilter).toHaveBeenCalledTimes(2);
      } else {
        await expect(extraction).rejects.toMatchObject({ code: "entry-filtered" });
        expect(await fs.readdir(fixture.destDir)).toEqual([]);
        expect(entryFilter).toHaveBeenCalledTimes(1);
        if (mode === "require") expect(extractNative).not.toHaveBeenCalled();
      }
      expect(entryFilter).toHaveBeenNthCalledWith(1, { path: "./pkg/link", kind: "symlink", size: 0 });
    });
  });
}
