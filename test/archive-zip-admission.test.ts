import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";
import { zipRecords, unicodePath, type ZipRecord } from "./helpers/zip-records.js";
import { rawTraversalZips } from "./helpers/zip-traversal-fixtures.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

for (const mode of ["off", "require", "auto-native", "auto-missing"] as const) {
  describe.skipIf((mode === "require" || mode === "auto-native") && !native)(`physical ZIP admission (${mode})`, () => {
    async function fixture(bytes: Buffer) {
      configureFsSafeNative({ mode: mode.startsWith("auto-") ? "auto" : mode as "off" | "require" });
      __setNativeLoaderForTest(() => {
        if (mode === "auto-missing") throw new Error("fixture binding absent");
        return native!;
      });
      const work = await tempRoot("fs-safe-zip-admission-");
      const archivePath = path.join(work, "input.zip"); const destDir = path.join(work, "destination");
      const outside = path.join(work, "outside", "sentinel");
      await fs.mkdir(destDir); await fs.mkdir(path.dirname(outside));
      await fs.writeFile(outside, "outside"); await fs.writeFile(path.join(destDir, "sentinel"), "existing");
      await fs.writeFile(archivePath, bytes);
      return { archivePath, destDir, outside };
    }
    async function rejected(bytes: Buffer, requested = "outside/sentinel", stripComponents = 0, code = "entry-path") {
      const input = await fixture(bytes); const entryFilter = vi.fn(() => "skip" as const);
      await expect(extractArchive({ ...input, kind: "zip", stripComponents, entryFilter, onFiltered: "skip-entry" })).rejects.toMatchObject({ code });
      expect(entryFilter).not.toHaveBeenCalled();
      await expect(readArchiveEntry(input.archivePath, requested, { maxBytes: 32 })).rejects.toMatchObject({ code });
      expect(await fs.readdir(input.destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(input.destDir, "sentinel"), "utf8")).toBe("existing");
      expect(await fs.readFile(input.outside, "utf8")).toBe("outside");
    }
    it.each(rawTraversalZips)("rejects preserved raw repro $sha256", async ({ bytes, sha256 }) => {
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
      await rejected(bytes);
    });
    it.each(["../outside/sentinel", "nested/../../outside/sentinel", "nested/../sentinel", "nested\\..\\sentinel", "../dir/", "/absolute", "C:relative", "safe/\0bad"])("rejects original %s in every position", async (name) => {
      for (const records of [[{ name }, { name: "good" }], [{ name: "good" }, { name }]]) {
        await rejected(zipRecords(records), "good");
      }
    });
    it.each([0, 1, 99])("validates before strip=%s and explicit skip", async (strip) => {
      await rejected(zipRecords([{ name: "nested/../sentinel", attributes: 0x10 }]), "sentinel", strip);
    });
    it.each([
      [{ name: "same" }, { name: "same" }],
      [{ name: "same" }, { name: "./same" }],
      [{ name: "same/" }, { name: "same", attributes: 0x10 }],
      [{ name: "a", extra: unicodePath(Buffer.from("a"), "same") }, { name: "same" }],
      [{ name: "same", extra: unicodePath(Buffer.from("same"), "a") }, { name: "same", extra: unicodePath(Buffer.from("same"), "b") }],
    ] satisfies ZipRecord[][])("rejects hidden collisions %j before returning an unrelated member", async (...entries) => {
      await rejected(zipRecords([...entries, { name: "good" }]), "good");
      await rejected(zipRecords([{ name: "good" }, ...entries.toReversed()]), "good");
    });
    it.each([
      { name: "../bad", localName: "safe" }, { name: "safe", localName: "../bad" },
      { name: "../bad", extra: unicodePath(Buffer.from("../bad"), "safe") },
      { name: "safe", extra: unicodePath(Buffer.from("safe"), "../bad") },
    ])("rejects dangerous metadata candidate %j", async (entry) => { await rejected(zipRecords([entry]), "safe"); });
    it("rejects material central/local and UTF8/Unicode conflicts", async () => {
      await rejected(zipRecords([{ name: "central", localName: "local" }]), "local", 0, "archive-header-invalid");
      await rejected(zipRecords([{ name: "safe", flags: 0x800, extra: unicodePath(Buffer.from("safe"), "other") }]), "safe", 0, "archive-header-invalid");
    });
    it("keeps fully stripped entries out of the callback while counting physical records", async () => {
      const input = await fixture(zipRecords([{ name: "good" }, { name: "other" }])); const entryFilter = vi.fn(() => "extract" as const);
      await extractArchive({ ...input, kind: "zip", stripComponents: 99, entryFilter });
      expect(entryFilter).not.toHaveBeenCalled();
      await expect(extractArchive({ ...input, kind: "zip", stripComponents: 99, limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: "archive-entry-count-exceeds-limit" });
    });
    it.each([false, true])("preserves payload decoding and ZIP64=%s with comments/descriptors", async (wide) => {
      const input = await fixture(zipRecords([
        { name: "stored", body: "stored", zip64: wide },
        { name: "deflated", body: "deflated", deflate: true, descriptor: true, zip64: wide },
      ], { zip64: wide, comment: Buffer.from("comment") }));
      await extractArchive({ ...input, kind: "zip" });
      expect(await fs.readFile(path.join(input.destDir, "deflated"), "utf8")).toBe("deflated");
      expect((await readArchiveEntry(input.archivePath, "stored", { maxBytes: 32 })).toString()).toBe("stored");
    });
    it.each([
      { name: "é", flags: 0x800 },
      { name: "legacy", extra: unicodePath(Buffer.from("legacy"), "é") },
    ])("preserves valid Unicode presentation %j", async (entry) => {
      const input = await fixture(zipRecords([entry]));
      await extractArchive({ ...input, kind: "zip" });
      expect(await fs.readFile(path.join(input.destDir, "é"), "utf8")).toBe("payload");
      expect((await readArchiveEntry(input.archivePath, "é", { maxBytes: 32 })).toString()).toBe("payload");
    });
    it("preserves the selected decoder's supported optional end framing", async () => {
      const nativeMode = mode === "require" || mode === "auto-native";
      const input = await fixture(zipRecords([{ name: "good", zip64: nativeMode }], nativeMode
        ? { zip64: true, zip64ExtensibleData: Buffer.from([1, 0, 0, 0, 0, 0]) }
        : { directorySignature: Buffer.from("signature") }));
      await extractArchive({ ...input, kind: "zip" });
      expect(await fs.readFile(path.join(input.destDir, "good"), "utf8")).toBe("payload");
      expect((await readArchiveEntry(input.archivePath, "good", { maxBytes: 32 })).toString()).toBe("payload");
    });
  });
}
