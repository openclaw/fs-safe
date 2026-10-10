import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, loadZipArchiveWithPreflight, readArchiveEntry } from "../src/archive.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { fixtureCrc32, unicodePath, zipExtra, zipRecords } from "./helpers/zip-records.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
afterEach(__resetFsSafeNativeConfigForTest);

function commentField(previous: Buffer, value: Buffer): Buffer {
  const header = Buffer.alloc(5); header[0] = 1; header.writeUInt32LE(fixtureCrc32(previous), 1);
  return zipExtra(0x6375, Buffer.concat([header, value]));
}
async function input(bytes: Buffer) {
  const root = await tempRoot("zip-unicode-fields-");
  const archivePath = path.join(root, "input.zip"), destDir = path.join(root, "out");
  await fs.mkdir(destDir); await fs.writeFile(archivePath, bytes);
  return { archivePath, destDir, timeoutMs: 10000 };
}
async function manifest(bytes: Buffer) {
  const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
  return (await native!.openZipBufferNative(owned, resolveTarMeterLimits())).entries;
}

describe.skipIf(!native)("native ZIP Unicode extra fields", () => {
  it.each(["crc", "utf8"] as const)("retains rejection of invalid Unicode Comment %s before callbacks and reads", async corruption => {
    configureFsSafeNative({ mode: "require" });
    const comment = Buffer.from("original comment");
    const extra = commentField(comment, corruption === "utf8" ? Buffer.from([0xff]) : Buffer.from("Unicode comment"));
    if (corruption === "crc") extra[5] ^= 1;
    const bytes = zipRecords([{ name: "payload", comment, extra }]);
    const fixture = await input(bytes), calls: unknown[] = [];
    await expect(extractArchive({ ...fixture, entryFilter: entry => { calls.push(entry); return "skip"; }, onFiltered: "skip-entry" }))
      .rejects.toMatchObject({ code: "GenericFailure" });
    await expect(readArchiveEntry(fixture.archivePath, "payload", { maxBytes: 7 })).rejects.toMatchObject({ code: "GenericFailure" });
    await expect(manifest(bytes)).rejects.toMatchObject({ code: "GenericFailure" });
    expect(calls).toEqual([]); expect(await fs.readdir(fixture.destDir)).toEqual([]);
  });

  it.each([
    { comment: Buffer.from("ASCII"), decoded: "ASCII", flags: 0 },
    { comment: Buffer.from([0x82]), decoded: "é", flags: 0 },
    { comment: Buffer.from("雪"), decoded: "雪", flags: 0x800 },
    { comment: Buffer.from([0xff]), decoded: "�", flags: 0x800 },
  ])("retains valid native decoded-comment CRC and field chaining: %j", async ({ comment, decoded, flags }) => {
    configureFsSafeNative({ mode: "require" });
    const extra = Buffer.concat([commentField(Buffer.from(decoded), Buffer.from("first")), commentField(Buffer.from("first"), Buffer.from("last"))]);
    const fixture = await input(zipRecords([{ name: "payload", comment, flags, extra }]));
    await extractArchive(fixture);
    expect(await readArchiveEntry(fixture.archivePath, "payload", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
  });

  it("retains native Path field order while public admission rejects duplicate critical fields", async () => {
    const extra = Buffer.concat([unicodePath(Buffer.from("payload"), "first"), unicodePath(Buffer.from("first"), "last")]);
    const bytes = zipRecords([{ name: "payload", extra }]);
    expect(await manifest(bytes)).toMatchObject([{ path: "last" }]);
    await expect(loadZipArchiveWithPreflight(bytes)).rejects.toMatchObject({ code: "archive-header-invalid" });
  });

  it("rejects a repeated Path field bound to an earlier name", async () => {
    const field = unicodePath(Buffer.from("payload"), "first");
    await expect(manifest(zipRecords([{ name: "payload", extra: Buffer.concat([field, field]) }])))
      .rejects.toMatchObject({ code: "GenericFailure" });
  });
});
