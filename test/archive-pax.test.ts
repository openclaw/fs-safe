import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxArchive, paxRecord, publicMetadata } from "./helpers/archive-pax.js";
import { useTempDirs } from "./helpers/vitest.js";
import { paxNative } from "./helpers/archive-pax-native.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`bounded PAX mode=${mode}`, () => {
    let inspectNative: ReturnType<typeof vi.fn>;
    let extractNative: ReturnType<typeof vi.fn>;
    let readNative: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") {
        // Deliberately fail if unavailable: these regressions must execute Rust.
        const native = paxNative!;
        inspectNative = vi.fn(native.inspectArchiveNative.bind(native));
        extractNative = vi.fn(native.extractArchiveNative.bind(native));
        readNative = vi.fn(native.readArchiveEntryNative.bind(native));
        __setNativeLoaderForTest(() => ({ ...native, inspectArchiveNative: inspectNative, extractArchiveNative: extractNative, readArchiveEntryNative: readNative }));
      }
    });

    async function check(bytes: Buffer, expected: Buffer, name: string, gzip: boolean): Promise<void> {
      const root = await tempRoot("fs-safe-pax-");
      const archivePath = path.join(root, gzip ? "fixture.tar.gz" : "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.writeFile(archivePath, gzip ? gzipSync(bytes) : bytes);
      await fs.mkdir(destDir);
      await extractArchive({ archivePath, destDir, timeoutMs: 10_000 });
      expect(await fs.readFile(path.join(destDir, name))).toEqual(expected);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("end");
      expect(await readArchiveEntry(archivePath, name, { maxBytes: expected.length })).toEqual(expected);
      expect(await readArchiveEntry(archivePath, "sentinel", { maxBytes: 3 })).toEqual(Buffer.from("end"));
      if (mode === "require") {
        expect(inspectNative).toHaveBeenCalledTimes(3);
        expect(extractNative).toHaveBeenCalledTimes(1);
        expect(readNative).toHaveBeenCalledTimes(2);
      }
    }

    it.each([false, true])("accepts public release binary provenance (gzip=%s)", async (gzip) => {
      const metadata = publicMetadata();
      expect(Buffer.byteLength(metadata.body!)).toBe(136);
      await check(tarFixture([metadata, { path: "crabbox", body: "payload" }, { path: "sentinel", body: "end" }]), Buffer.from("payload"), "crabbox", gzip);
    });

    it.each([[1, 700], [700, 1], [700, 0]])("uses PAX size instead of raw size %i -> %i", async (raw, size) => {
      const body = Buffer.alloc(size, 0x61);
      await check(paxArchive([["path", "package/value"], ["size", String(size)]], body, raw), body, "package/value", false);
    });

    it("keeps structural records after binary non-UTF8 xattrs intact", async () => {
      const body = Buffer.alloc(700, 0x62);
      await check(paxArchive([
        ["SCHILY.xattr.user.binary", Buffer.from([0, 0xff, 0xfe, 0xc3])],
        ["path", "renamed"], ["size", "700"],
      ], body, 1), body, "renamed", true);
    });

    it("accepts ignored binary metadata at the default ceiling across parser chunks", async () => {
      const key = "SCHILY.xattr.user.binary";
      const limit = 1024 * 1024;
      const value = Buffer.alloc(limit - paxRecord(key, "").length - 5, 0xff);
      // The larger decimal length prefix adds five bytes at this body size.
      expect(paxRecord(key, value).length).toBe(limit);
      const bytes = paxArchive([[key, value]]);
      await check(bytes, Buffer.from("payload"), "raw", true);
    });
  });
}
