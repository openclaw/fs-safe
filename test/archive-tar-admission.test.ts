import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { admissionCases, linknameCases, manifestArchive, manifestMember, routeAdmissionCases, routeLinknameCases } from "./helpers/archive-admission.js";
import { tarAdmissionRoutes } from "./helpers/archive-admission-matrix.js";
import { compressedAdmission } from "./helpers/archive-admission-compressed.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

// All header variants run on off/tar and require/zstd. Each other route keeps
// checksum, strict fixed fields (including metadata replacement), normalization,
// GNU file/directory/D semantics, forbidden/required/valid linknames, and budget
// checks. Explicit fixture lists avoid repeating every type/field/replacement
// combination ten times. GNU/PAX budgets both run on the full routes; other
// routes alternate them by mode (auto=PAX, off/require=GNU).
for (const { mode, format, full } of tarAdmissionRoutes) {
  describe.skipIf(mode !== "off" && !paxNative)(`raw admission ${mode} ${format}`, () => {
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
    async function setup(name: string, raw: () => Buffer) {
      const root = await tempRoot("fs-safe-admission-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      const bytes = format === "tar" ? raw() : format === "gzip" ? gzipSync(raw())
        : Buffer.from(compressedAdmission[name]![format]!, "base64");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind: format === "gzip" ? "tar" as const : format, timeoutMs: 10_000 };
    }
    async function unchanged(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
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
}
