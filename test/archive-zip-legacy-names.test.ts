import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { unicodePath, zipRecords } from "./helpers/zip-records.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
afterEach(__resetFsSafeNativeConfigForTest);

async function fixture(bytes: Buffer) {
  const root = await tempRoot("zip-legacy-names-");
  const archivePath = path.join(root, "input.zip"), destDir = path.join(root, "out");
  await fs.writeFile(archivePath, bytes); await fs.mkdir(destDir);
  return { archivePath, destDir, timeoutMs: 10000 };
}

describe.skipIf(!native)("native ZIP legacy name contract", () => {
  it.each(["require", "auto"] as const)("keeps CP437 for unflagged UTF-8-shaped bytes in %s", async mode => {
    configureFsSafeNative({ mode });
    const input = await fixture(zipRecords([{ name: Buffer.from("café"), body: "contents" }]));
    const calls: unknown[] = [];
    await extractArchive({ ...input, entryFilter: entry => { calls.push(entry); return "extract"; } });
    expect(calls).toEqual([{ path: "caf├⌐", kind: "file", size: 8 }]);
    expect(await fs.readdir(input.destDir)).toEqual(["caf├⌐"]);
    expect(await readArchiveEntry(input.archivePath, "caf├⌐", { maxBytes: 8 })).toEqual(Buffer.from("contents"));
    await expect(readArchiveEntry(input.archivePath, "café", { maxBytes: 8 })).rejects.toThrow("not found");
  });

  it("rejects a legacy/Unicode collision before callbacks and selected reads", async () => {
    configureFsSafeNative({ mode: "require" });
    const input = await fixture(zipRecords([
      { name: "keep" }, { name: Buffer.from("é") }, { name: "├⌐", flags: 0x800 },
    ]));
    const calls: unknown[] = [];
    await expect(extractArchive({ ...input, entryFilter: entry => { calls.push(entry); return "skip"; }, onFiltered: "skip-entry" }))
      .rejects.toMatchObject({ code: "entry-path" });
    await expect(readArchiveEntry(input.archivePath, "keep", { maxBytes: 7 })).rejects.toMatchObject({ code: "entry-path" });
    expect(calls).toEqual([]);
    expect(await fs.readdir(input.destDir)).toEqual([]);
  });

  it.each(["flag", "unicode"] as const)("retains an explicitly declared UTF-8 name via %s", async source => {
    configureFsSafeNative({ mode: "require" });
    const extra = unicodePath(Buffer.from("legacy"), "café");
    const record = source === "flag" ? { name: "café", flags: 0x800 }
      : { name: "legacy", extra, localExtra: extra };
    const input = await fixture(zipRecords([record]));
    await extractArchive(input);
    expect(await fs.readdir(input.destDir)).toEqual(["café"]);
    expect(await readArchiveEntry(input.archivePath, "café", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
  });

  it.each([
    Buffer.from([0xff]), Buffer.from([0xc0, 0xae]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82]),
  ])("fails closed on malformed flagged UTF-8 in the native metadata boundary: %j", async name => {
    const bytes = zipRecords([{ name, flags: 0x800 }]);
    const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
    await expect(native!.openZipBufferNative(owned, resolveTarMeterLimits())).rejects.toThrow("archive-header-invalid");
  });

  it.each([0, 0x800])("retains native Unicode Path CRC rejection with flags %s", async flags => {
    const extra = unicodePath(Buffer.from("payload"), "different"); extra[5] ^= 1;
    const bytes = zipRecords([{ name: "payload", flags, extra }]);
    const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
    await expect(native!.openZipBufferNative(owned, resolveTarMeterLimits())).rejects.toThrow("archive-header-invalid");
  });
});
