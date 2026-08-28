import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry, type ExtractArchiveOptions } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture, type TarFixtureEntry } from "./helpers/archive-fuzz.js";
import { paxArchive, paxHeader, paxRecord, publicMetadata } from "./helpers/archive-pax.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const invalid = "archive-header-invalid";
const member = { path: "raw", body: "payload" };

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`PAX security mode=${mode}`, () => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    });

    async function setup(bytes: Buffer) {
      const root = await tempRoot("fs-safe-pax-security-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      return { archivePath, destDir, timeoutMs: 10_000 };
    }

    async function reject(bytes: Buffer, code = invalid, options: Partial<ExtractArchiveOptions> = {}, read = true) {
      const fixture = await setup(bytes);
      await expect(extractArchive({ ...fixture, ...options })).rejects.toMatchObject({ code });
      expect(await fs.readdir(fixture.destDir)).toEqual([]);
      if (read) await expect(readArchiveEntry(fixture.archivePath, "raw", { maxBytes: 1000 })).rejects.toMatchObject({ code });
    }

    it.each([
      ["empty path", "path", ""], ["empty linkpath", "linkpath", ""], ["empty size", "size", ""],
      ["negative size", "size", "-1"], ["signed size", "size", "+1"], ["fractional size", "size", "1.5"],
      ["exponent", "size", "1e3"], ["hex", "size", "0x10"], ["leading zero", "size", "01"],
      ["unsafe integer", "size", "9007199254740992"], ["unsafe padding", "size", "9007199254740990991"],
      ["padding overflow", "size", "9007199254740991"], ["space", "size", " 1"],
      ["NUL path", "path", "ok\0evil"], ["Unicode path", "path", "café"],
      ["Unicode linkpath", "linkpath", "café"], ["Unicode owner", "uname", "café"],
      ["non-ASCII key", "päth", "ok"], ["newline xattr", "SCHILY.xattr.user.binary", "ok\nbad"],
      ["charset", "hdrcharset", "BINARY"], ["charset alias", "charset", "UTF-8"],
      ["sparse map", "GNU.sparse.map", "0,1"], ["sparse name", "GNU.sparse.name", "raw"],
      ["sparse size", "GNU.sparse.size", "1"], ["sparse 1.0", "GNU.sparse.major", "1"],
      ["SCHILY sparse", "SCHILY.filetype", "sparse"], ["realsize", "SCHILY.realsize", "1"],
      ["SCHILY size", "SCHILY.size", "1"], ["ACL", "SCHILY.acl.access", "user::rwx"],
      ["unknown", "vendor.unknown", "value"], ["type override", "type", "5"],
      ["negative uid", "uid", "-1"], ["invalid time", "mtime", "Infinity"],
      ["out of range time", "mtime", "8640000000001"], ["empty owner", "uname", ""],
      ["empty namespace suffix", "SCHILY.xattr.", "value"],
    ])("rejects %s", async (_label, key, value) => {
      await reject(paxArchive([[key!, value!]]));
    });

    it.each([
      Buffer.from(""), Buffer.from("9 path=a"), Buffer.from("8 path=a\n"), Buffer.from("11 path=a\n"),
      Buffer.from("09 path=a\n"), Buffer.from("+9 path=a\n"), Buffer.from("0 path=a\n"),
      Buffer.from("999999999999999999999999 path=a\n"), Buffer.from("9 path=a\0"),
      Buffer.from("9 path=a\ntrailing"), Buffer.from("9 path=a\n\n"),
      paxRecord("path", "a\nb"), paxRecord("bad key", "value"),
      Buffer.concat([paxRecord("path", "a"), paxRecord("path", "b")]),
      Buffer.concat([paxRecord("size", "1"), paxRecord("size", "7")]),
      Buffer.concat([paxRecord("SCHILY.xattr.user.binary", "a"), paxRecord("SCHILY.xattr.user.binary", "b")]),
    ])("rejects malformed framing or duplicates %#", async (body) => {
      await reject(tarFixture([{ path: "PaxHeader", type: "x", body }, member]));
    });

    it("rejects global, old, dangling, repeated and mixed extension chains", async () => {
      const pax = paxHeader([["path", "renamed"]]);
      const gnu = { path: "LongName", type: "L", body: "long-name\0" };
      const chains: TarFixtureEntry[][] = [
        [{ ...pax, type: "g" }, member], [{ ...pax, type: "X" }, member],
        [{ ...pax, type: "N" }, member], [pax], [pax, pax, member],
        [pax, gnu, member], [gnu, pax, member], [pax, { ...gnu, type: "K" }, member],
        [pax, { path: "device", type: "3" }],
        [{ ...pax, mutateHeader: (header) => header.fill(0, 257, 265) }, member],
      ];
      for (const chain of chains) await reject(tarFixture(chain));
      await reject(tarFixture([pax], false));
    });

    it("rejects dangling metadata after TAR end blocks on the complete input", async () => {
      await reject(Buffer.concat([tarFixture([member]), tarFixture([paxHeader([["path", "dangling"]])])]));
    });

    it.each([
      ["1", 1, 0], ["1", 0, 1], ["1", 1, 1],
      ["2", 1, 0], ["2", 0, 1], ["2", 1, 1],
      ["5", 1, 0], ["5", 0, 1], ["5", 1, 1],
    ] as const)("rejects non-file type %s with raw size %i and effective size %i", async (type, rawSize, effectiveSize) => {
      await reject(tarFixture([paxHeader([["size", String(effectiveSize)]]), {
        path: "raw", type, linkPath: "target",
        mutateHeader: (header) => header.write(`${rawSize.toString(8).padStart(11, "0")}\0`, 124, "ascii"),
      }]));
    });

    it.each(["0", "7", "1", "2"])("rejects separator coercions for type %s", async (type) => {
      await reject(tarFixture([paxHeader([["path", "dir/"]]), { ...member, type }]));
      await reject(tarFixture([paxHeader([["path", "safe"]]), { path: "raw/", type }]));
    });

    it("rejects linkpath overrides on non-link members", async () => {
      await reject(paxArchive([["linkpath", "target"]]));
    });

    it("rejects backslash directory coercion", async () => {
      await reject(paxArchive([["path", "dir\\"]]));
    });

    it("rejects ambiguous raw text, raw numbers and link fields even when overridden", async () => {
      for (const entry of [
        { ...member, path: "café" },
        { ...member, linkPath: "not-a-link" },
        { path: "link", type: "2", linkPath: "" },
        { ...member, mutateHeader: (header: Buffer) => { header[124] = 0xb0; } },
        { ...member, mutateHeader: (header: Buffer) => { header.write("café", 345, "utf8"); } },
      ]) await reject(tarFixture([paxHeader([["path", "safe"], ["size", "0"]]), entry]));
    });

    it("applies exact and over metadata, member, total and entry-count limits", async () => {
      const body = Buffer.alloc(700, 0x61);
      const bytes = paxArchive([["path", "renamed"], ["size", "700"]], body, 1);
      const meta = Buffer.byteLength(paxHeader([["path", "renamed"], ["size", "700"]]).body!);
      await extractArchive({ ...await setup(bytes), limits: { maxMetaEntryBytes: meta, maxEntries: 2, maxEntryBytes: 700, maxExtractedBytes: 703 } });
      for (const [limits, code] of [
        [{ maxMetaEntryBytes: meta - 1 }, "archive-meta-entry-size-exceeds-limit"],
        [{ maxMetaEntryBytes: 0 }, "archive-meta-entry-size-exceeds-limit"],
        [{ maxEntries: 1 }, "archive-entry-count-exceeds-limit"],
        [{ maxEntries: 0 }, "archive-entry-count-exceeds-limit"],
        [{ maxEntryBytes: 699 }, "archive-entry-extracted-size-exceeds-limit"],
        [{ maxExtractedBytes: 702 }, "archive-extracted-size-exceeds-limit"],
      ] as const) await reject(bytes, code, { limits }, false);
      const fixture = await setup(bytes);
      await expect(readArchiveEntry(fixture.archivePath, "renamed", { maxBytes: 699 })).rejects.toMatchObject({ code: "archive-entry-extracted-size-exceeds-limit" });
    });

    it("returns the same default metadata limit error from extraction and reads", async () => {
      await reject(paxArchive([["SCHILY.xattr.user.binary", Buffer.alloc(1024 * 1024, 0xff)]]), "archive-meta-entry-size-exceeds-limit");
    });

    it("meters forbidden old headers and sparse chains before format rejection", async () => {
      for (const type of ["g", "X", "N"]) {
        const bytes = tarFixture([{ path: "metadata", type, mutateHeader: (header) => header.write("00000001001\0", 124, "ascii") }]);
        await reject(bytes, "archive-meta-entry-size-exceeds-limit", { limits: { maxMetaEntryBytes: 512 } }, false);
      }
      const sparse = tarFixture([{ path: "sparse", type: "S", mutateHeader: (header) => {
        header.write("ustar  \0", 257, "ascii");
        header[482] = 1;
      } }], false);
      const bytes = Buffer.concat([tarFixture([paxHeader([["path", "safe"]])], false), sparse, Buffer.alloc(512)]);
      await reject(bytes, "archive-meta-entry-size-exceeds-limit", { limits: { maxMetaEntryBytes: 511 } }, false);
      await reject(bytes);
    });

    it("preserves standalone GNU long-name and long-link handling", async () => {
      const long = "directory/" + "a".repeat(120);
      const fixture = await setup(tarFixture([{ path: "LongName", type: "L", body: long + "\0" }, member]));
      await extractArchive(fixture);
      expect(await fs.readFile(path.join(fixture.destDir, long), "utf8")).toBe("payload");
      expect(await readArchiveEntry(fixture.archivePath, long, { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      await reject(tarFixture([{ path: "LongLink", type: "K", body: long + "\0" }, { path: "link", type: "2", linkPath: "raw" }]), "entry-link", {}, false);
    });

    it("keeps traversal before stripping/filtering and checks effective depth/collisions", async () => {
      for (const badPath of ["../escape", "/absolute", "a/../../escape", "C:escape"]) {
        await reject(paxArchive([["path", badPath]]), "entry-path", { stripComponents: 20, entryFilter: () => "skip", onFiltered: "skip-entry" });
      }
      await reject(paxArchive([["path", "a/b/c"]]), "archive-entry-path-components-exceeds-limit", { limits: { maxEntryPathComponents: 2 } }, false);
      for (const alias of ["sentinel", "SENTINEL"]) await reject(paxArchive([["path", alias]]), "entry-path", {}, false);
      await reject(tarFixture([paxHeader([["path", "a/value"]]), member, { path: "b/value" }]), "entry-path", { stripComponents: 1 }, false);
    });

    it("filters using effective path/size and preserves stripped/skipped byte budgets", async () => {
      const bytes = paxArchive([["path", "package/renamed"], ["size", "700"]], Buffer.alloc(700), 1);
      const seen: Array<{ path: string; size: number }> = [];
      const fixture = await setup(bytes);
      await extractArchive({ ...fixture, limits: { maxEntryBytes: 3, maxExtractedBytes: 3 }, onFiltered: "skip-entry", entryFilter: (entry) => {
        seen.push(entry);
        return entry.path === "package/renamed" ? "skip" : "extract";
      } });
      expect(seen).toMatchObject([{ path: "package/renamed", size: 700 }, { path: "sentinel", size: 3 }]);
      expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
      await reject(bytes, "entry-filtered", { entryFilter: () => "skip" }, false);
      await reject(bytes, "archive-entry-count-exceeds-limit", { limits: { maxEntries: 1 }, stripComponents: 9 }, false);
      await extractArchive({ ...await setup(bytes), stripComponents: 9, limits: { maxEntryBytes: 0, maxExtractedBytes: 0 } });
    });

    it("accepts descriptive metadata and zero-size directories without restoring ownership", async () => {
      const fixture = await setup(tarFixture([paxHeader([
        ["path", "directory/"], ["size", "0"], ["uid", "123"], ["gid", "456"],
        ["uname", "nobody"], ["gname", "nogroup"], ["mtime", "-1.25"], ["atime", "0.01"], ["ctime", "123.456"],
      ]), { path: "raw", type: "5" }, publicMetadata(), member]));
      await extractArchive(fixture);
      expect((await fs.stat(path.join(fixture.destDir, "directory"))).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(fixture.destDir, "raw"), "utf8")).toBe("payload");
    });

    it.each(["1", "2"])("never grants link permission for PAX type %s", async (type) => {
      const bytes = tarFixture([paxHeader([["path", "link"], ["linkpath", "../outside"], ["size", "0"]]), { path: "raw", type, linkPath: "target" }]);
      await reject(bytes, "entry-link", {}, false);
      const fixture = await setup(bytes);
      await expect(readArchiveEntry(fixture.archivePath, "link", { maxBytes: 10 })).rejects.toThrow("not a file");
      await extractArchive({ ...fixture, entryFilter: () => "skip", onFiltered: "skip-entry" });
      expect(await fs.readdir(fixture.destDir)).toEqual([]);
      await extractArchive({ ...fixture, stripComponents: 2 });
    });
  });
}
