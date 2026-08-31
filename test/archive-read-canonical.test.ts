import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarReadArchives, tarReadMembers, zipReadArchives, zipReadMembers } from "./helpers/archive-read-canonical.js";
import { compressedReadArchives } from "./helpers/archive-read-canonical-compressed.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

// Each route extracts the shared member fixture once, then independently reads
// every canonical/raw alias. TAR includes GNU Unicode, PAX paths and NUL typeflags;
// ZIP includes Unicode Path metadata. Native routes use the actual binding.
const routes = [
  { mode: "off", format: "zip" }, { mode: "off", format: "tar" }, { mode: "off", format: "gzip" },
  { mode: "require", format: "zip" }, { mode: "require", format: "tar" }, { mode: "require", format: "gzip" },
  { mode: "require", format: "tar-zstd" }, { mode: "require", format: "tar-bzip2" },
] as const;
for (const { mode, format } of routes) {
  describe.skipIf(mode === "require" && !paxNative)(`canonical reads ${mode} ${format}`, () => {
    const kind = format === "gzip" ? "tar" : format;
    const members = format === "zip" ? zipReadMembers : tarReadMembers;
    let inspectNative: ReturnType<typeof vi.fn>;
    let readNative: ReturnType<typeof vi.fn>;
    let extractNative: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") {
        const native = paxNative!;
        inspectNative = vi.fn(native.inspectArchiveNative.bind(native));
        readNative = vi.fn(native.readArchiveEntryNative.bind(native));
        extractNative = vi.fn(native.extractArchiveNative.bind(native));
        __setNativeLoaderForTest(() => ({ ...native, inspectArchiveNative: inspectNative,
          readArchiveEntryNative: readNative, extractArchiveNative: extractNative }));
      }
    });
    async function setup(name: keyof typeof tarReadArchives = "members") {
      const root = await tempRoot("fs-safe-canonical-read-");
      const archivePath = path.join(root, "fixture.bin");
      const destDir = path.join(root, "out");
      const bytes = format === "zip" ? zipReadArchives[name]
        : format === "tar" ? tarReadArchives[name]
        : format === "gzip" ? gzipSync(tarReadArchives[name])
        : Buffer.from(compressedReadArchives[name][format], "base64");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, kind };
    }
    async function unchanged(destDir: string) {
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
    }
    function nativeRead(called: boolean) {
      if (mode !== "require") return;
      expect(inspectNative).toHaveBeenCalledTimes(1);
      expect(readNative).toHaveBeenCalledTimes(called ? 1 : 0);
    }

    it("extracts the same canonical identities exposed to the filter and reader", async () => {
      const options = await setup();
      const entryFilter = vi.fn(() => "extract" as const);
      await extractArchive({ ...options, entryFilter });
      expect(entryFilter.mock.calls).toEqual(members.map(({ canonical, body }) => [
        { path: canonical, kind: "file", size: Buffer.byteLength(body) },
      ]));
      for (const member of members) {
        expect(await fs.readFile(path.join(options.destDir, member.canonical))).toEqual(Buffer.from(member.body));
      }
      expect((await fs.readdir(options.destDir, { recursive: true })).sort()).toEqual(
        ["sentinel", "pkg", ...members.map(({ canonical }) => canonical.split("/").join(path.sep))].sort(),
      );
      if (mode === "require") expect(extractNative).toHaveBeenCalledTimes(1);
    });

    it.each(members.flatMap((member) => [
      { ...member, requested: member.canonical }, { ...member, requested: member.raw },
    ]))("reads $canonical using request $requested", async ({ requested, body }) => {
      const options = await setup();
      await expect(readArchiveEntry(options.archivePath, requested, { kind, maxBytes: Buffer.byteLength(body) }))
        .resolves.toEqual(Buffer.from(body));
      await unchanged(options.destDir);
      nativeRead(true);
      if (mode === "require") {
        const manifest = await inspectNative.mock.results[0]!.value;
        // Rust must receive the selected manifest spelling, not the canonical alias.
        expect(manifest.some((entry: { path: string }) => entry.path === readNative.mock.calls[0]![2])).toBe(true);
      }
    });

    it.each(["/", "\\"])("rejects a directory request ending in %s before archive access", async (separator) => {
      const requested = `./pkg//repeated${separator}`;
      await expect(readArchiveEntry("missing.bin", requested, { kind, maxBytes: 8 }))
        .rejects.toMatchObject({ name: "Error", message: `archive entry is not a file: ${requested}` });
      if (mode === "require") expect(inspectNative).not.toHaveBeenCalled();
    });

    it.each(format === "zip" ? ["directory", "symlink"] : ["directory", "hardlink", "symlink", "volume", "unknown"])(
      "keeps aliased %s entries non-files", async (name) => {
        const options = await setup("nonfiles");
        const requested = `pkg/${name}`;
        const message = mode === "off" && format === "zip"
          ? name === "directory" ? `archive entry not found: ${requested}` : `archive entry is a link: ${requested}`
          : `archive entry is not a file: ${requested}`;
        await expect(readArchiveEntry(options.archivePath, requested, { kind, maxBytes: 16 }))
          .rejects.toMatchObject({ name: "Error", message });
        await unchanged(options.destDir);
        nativeRead(false);
      },
    );

    it("rejects canonical collisions before returning an unrelated member or publishing", async () => {
      const options = await setup("collision");
      const error = { name: "ArchiveSecurityError", code: "entry-path" };
      await expect(readArchiveEntry(options.archivePath, "keep", { kind, maxBytes: 4 })).rejects.toMatchObject(error);
      await expect(extractArchive(options)).rejects.toMatchObject(error);
      await unchanged(options.destDir);
      if (mode === "require") { expect(readNative).not.toHaveBeenCalled(); expect(extractNative).not.toHaveBeenCalled(); }
    });

    it("reads an unrelated file alongside aliased non-file entries", async () => {
      const options = await setup("nonfiles");
      await expect(readArchiveEntry(options.archivePath, "././keep", { kind, maxBytes: 4 }))
        .resolves.toEqual(Buffer.from("keep"));
      await unchanged(options.destDir);
      nativeRead(true);
    });

    if (format === "zip") {
      it("preserves ZIP integrity checks after canonical lookup", async () => {
        const options = await setup();
        const bytes = await fs.readFile(options.archivePath);
        const bodyOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
        bytes[bodyOffset] ^= 1;
        await fs.writeFile(options.archivePath, bytes);
        await expect(readArchiveEntry(options.archivePath, "pkg/repeated", { kind, maxBytes: 8 }))
          .rejects.toMatchObject(mode === "off"
            ? { name: "ArchiveFormatError", code: "archive-header-invalid" }
            : { name: "Error", code: "GenericFailure", message: "read archive entry: Invalid checksum" });
        await unchanged(options.destDir);
        nativeRead(true);
      });
    }

    it("validates raw paths hidden by effective metadata before reading", async () => {
      const options = await setup("unsafe");
      await expect(readArchiveEntry(options.archivePath, "./keep", { kind, maxBytes: 4 }))
        .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
      await unchanged(options.destDir);
      if (mode === "require") expect(readNative).not.toHaveBeenCalled();
    });

    it("preserves the selected entry byte limit after canonical lookup", async () => {
      const options = await setup();
      await expect(readArchiveEntry(options.archivePath, "./pkg//repeated", { kind, maxBytes: 7 }))
        .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-entry-extracted-size-exceeds-limit" });
      await unchanged(options.destDir);
    });
  });
}

it.each(["pkg/../value", "pkg\\..\\value", "/value", "C:value", "pkg/C:value", "pkg/val\0ue"])(
  "validates raw request %s before canonicalization or archive access", async (requested) => {
    await expect(readArchiveEntry("missing.tar", requested, { maxBytes: 1 }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
  },
);
