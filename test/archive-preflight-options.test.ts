import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as tar from "tar";
import { createTarEntryPreflightChecker, extractArchive, type ArchiveEntryFilter } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { modeArchive } from "./helpers/archive-modes.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const entry = { path: "value", type: "File", size: 5 };

afterEach(() => {
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.runIf(mode === "off" || Boolean(paxNative))(`structural extraction options (${mode})`, () => {
    it.each((["tar", "zip"] as const).flatMap((kind) => [true, false].map((allowed) => ({ kind, allowed }))))(
      "extractArchive retains getter-backed $kind options (allowed=$allowed)", async ({ kind, allowed }) => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
      const base = await tempRoot("fs-safe-extraction-options-");
      const archivePath = path.join(base, `archive.${kind}`);
      const destDir = path.join(base, "output");
      await fs.mkdir(destDir);
      await fs.writeFile(archivePath, await modeArchive(kind, [{ path: "pkg/value", mode: 0o700 }]));
      const entryFilter = vi.fn<ArchiveEntryFilter>(() => allowed ? "extract" : "skip");
      class Options {
        get archivePath() { return archivePath; }
        get destDir() { return destDir; }
        get timeoutMs() { return 10_000; }
        get stripComponents() { return 1; }
        get limits() { return { maxEntries: 1, maxEntryBytes: 3 }; }
        get entryModes() { return "preserve" as const; }
        get entryFilter() { return entryFilter; }
        get onFiltered() { return "reject-archive" as const; }
      }
      if (allowed) {
        await extractArchive(new Options());
        expect(await fs.readFile(path.join(destDir, "value"), "utf8")).toBe("NEW");
        if (process.platform !== "win32") expect((await fs.stat(path.join(destDir, "value"))).mode & 0o777).toBe(0o700);
      } else {
        await expect(extractArchive(new Options())).rejects.toMatchObject({ code: "entry-filtered" });
        expect(await fs.readdir(destDir)).toEqual([]);
      }
      expect(entryFilter).toHaveBeenCalledExactlyOnceWith({ path: "pkg/value", kind: "file", size: 3 });
    });
  });
}

describe("structural public preflight options", () => {
  it("reads inherited filters at each check rather than copying options", async () => {
    const rootDir = await tempRoot("fs-safe-preflight-filter-");
    let filter = vi.fn<ArchiveEntryFilter>(() => "extract");
    class Options {
      get rootDir() { return rootDir; }
      get entryFilter() { return filter; }
    }
    const check = createTarEntryPreflightChecker(new Options());
    expect(check(entry)).toBe(true);
    expect(filter).toHaveBeenCalledOnce();
    filter = vi.fn<ArchiveEntryFilter>(() => "skip");
    expect(() => check({ ...entry, path: "next" })).toThrow(expect.objectContaining({ code: "entry-filtered" }));
    expect(filter).toHaveBeenCalledOnce();
  });

  it("retains getter-backed limits, stripping and skip policy", async () => {
    const rootDir = await tempRoot("fs-safe-preflight-options-");
    class Limited {
      get rootDir() { return rootDir; }
      get limits() { return { maxEntries: 0 }; }
    }
    class Stripped {
      get rootDir() { return rootDir; }
      get stripComponents() { return 1; }
    }
    class Skipped {
      get rootDir() { return rootDir; }
      get entryFilter(): ArchiveEntryFilter { return () => "skip"; }
      get onFiltered() { return "skip-entry" as const; }
    }
    expect(() => createTarEntryPreflightChecker(new Limited())(entry))
      .toThrow(expect.objectContaining({ code: "archive-entry-count-exceeds-limit" }));
    expect(createTarEntryPreflightChecker(new Stripped())(entry)).toBe(false);
    expect(createTarEntryPreflightChecker(new Skipped())(entry)).toBe(false);
  });

  it.each([true, false])("custom extractor preserves getter policy (allowed=%s)", async (allowed) => {
    const rootDir = await tempRoot("fs-safe-preflight-extractor-");
    class Policy {
      get rootDir() { return rootDir; }
      get entryFilter(): ArchiveEntryFilter { return () => allowed ? "extract" : "skip"; }
    }
    class Options extends Policy {}
    const check = createTarEntryPreflightChecker(new Options());
    // The documented custom-extractor hook runs before node-tar starts member output.
    const extract = () => tar.x({ sync: true, cwd: rootDir, onReadEntry: check })
      .end(tarFixture([{ path: "value", body: "synthetic" }]));
    if (allowed) {
      extract();
      expect(await fs.readFile(path.join(rootDir, "value"), "utf8")).toBe("synthetic");
    } else {
      expect(extract).toThrow(expect.objectContaining({ code: "entry-filtered" }));
      expect(await fs.readdir(rootDir)).toEqual([]);
    }
  });
});
