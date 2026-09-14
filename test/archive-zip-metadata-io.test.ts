import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admitZipBuffer, admitZipFile } from "../src/archive-zip-admission.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { withExtractionDeadline, type ExtractionDeadline } from "../src/archive-deadline.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { zipRecords, zipExtra, unicodePath } from "./helpers/zip-records.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const limits = resolveExtractLimits();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });
async function fixture(bytes: Buffer) {
  const dir = await tempRoot("fs-safe-zip-metadata-io-");
  const file = path.join(dir, "input.zip");
  await fs.writeFile(file, bytes);
  return file;
}
function inspect(file: string) {
  return withExtractionDeadline(0, "metadata", deadline => admitZipFile(file, limits, deadline));
}

it("admits many records without issuing a filesystem read for each field", async () => {
  const file = await fixture(zipRecords(Array.from({ length: 1000 }, (_, i) => ({ name: `entry-${i}`, body: "value" }))));
  const read = vi.spyOn(fsSync, "read");
  expect(await inspect(file)).toBe(1000);
  expect(read.mock.calls.length).toBeGreaterThan(0);
  expect(read.mock.calls.length).toBeLessThan(200);
});

it("keeps metadata reads bounded when the archive contains a large payload", async () => {
  const file = await fixture(zipRecords([{ name: "large", body: Buffer.alloc(1024 * 1024) }]));
  const originalRead = fsSync.read;
  let requested = 0;
  vi.spyOn(fsSync, "read").mockImplementation(((...args: unknown[]) => {
    requested += args[3] as number;
    return Reflect.apply(originalRead, fsSync, args);
  }) as typeof fsSync.read);
  expect(await inspect(file)).toBe(1);
  expect(requested).toBeGreaterThan(0);
  expect(requested).toBeLessThan(128 * 1024);
});

it("keeps scanner views stable across cache eviction and oversized records", async () => {
  const largeExtra = zipExtra(0x8888, Buffer.alloc(5000, 97));
  const longName = ("x".repeat(63) + "/").repeat(63) + "y".repeat(23);
  const name = Buffer.from("raw");
  const bytes = zipRecords([
    { name, extra: Buffer.concat([largeExtra, unicodePath(name, "雪")]), localExtra: unicodePath(name, "雪"), body: "first" },
    { name: longName, body: "second", descriptor: true },
    { name: "wide", body: "third", zip64: true, descriptor: true },
  ], { zip64: true, prefix: Buffer.from("prefix") });
  const file = await fixture(bytes);
  const entries: string[] = [];
  expect(await withExtractionDeadline(0, "metadata", deadline => admitZipFile(file, limits, deadline, entry => {
    if (entry.path) entries.push(entry.path);
  }))).toBe(admitZipBuffer(bytes, limits));
  expect(entries).toEqual(["雪", longName, "wide"]);
});

it("completes short filesystem reads before interpreting records", async () => {
  const bytes = zipRecords([{ name: "one", body: "first", descriptor: true }, { name: "two", body: "second", zip64: true }], { zip64: true });
  const file = await fixture(bytes);
  const originalRead = fsSync.read;
  vi.spyOn(fsSync, "read").mockImplementation(((...args: unknown[]) => {
    args[3] = Math.min(args[3] as number, 7);
    return Reflect.apply(originalRead, fsSync, args);
  }) as typeof fsSync.read);
  expect(await inspect(file)).toBe(admitZipBuffer(bytes, limits));
});

it("rejects an incomplete required record and closes its descriptor", async () => {
  const file = await fixture(zipRecords([{ name: "one", body: "first" }]));
  const originalRead = fsSync.read;
  let fd: number | undefined;
  vi.spyOn(fsSync, "read").mockImplementation(((...args: unknown[]) => {
    fd = args[0] as number;
    fsSync.truncateSync(file, 0);
    return Reflect.apply(originalRead, fsSync, args);
  }) as typeof fsSync.read);
  await expect(inspect(file)).rejects.toThrow("truncated staged record");
  expect(() => fsSync.fstatSync(fd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("yields cached work for cancellation and closes the admitted descriptor", async () => {
  const file = await fixture(zipRecords(Array.from({ length: 1000 }, (_, i) => ({ name: `entry-${i}`, body: "value" }))));
  const controller = new AbortController();
  const reason = new Error("stop cached admission");
  const deadline: ExtractionDeadline = {
    signal: controller.signal, check: () => controller.signal.throwIfAborted(),
    ownDestinationMutation: async run => await run(), waitForDestinationMutations: async () => {}, dispose: () => {},
  };
  let admitted = 0;
  const reads = vi.spyOn(fsSync, "read");
  await expect(admitZipFile(file, limits, deadline, () => {
    if (++admitted === 1) setImmediate(() => controller.abort(reason));
  })).rejects.toBe(reason);
  expect(admitted).toBeLessThan(1000);
  const fd = reads.mock.calls[0]![0];
  expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
});
